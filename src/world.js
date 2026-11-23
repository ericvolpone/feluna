import * as THREE from 'three/webgpu';
import { paint, mulberry32, hash, smoothstep, lerp, clamp } from './util.js';

/**
 * Builds one level from its config (see levels.js).
 *
 * Terrain is an analytic height function so physics, placement and the mesh agree.
 * Static props are merged into chunked meshes (few draw calls). Collision uses
 * vertical cylinders ("circles": walkable on top, optionally climbable) and
 * axis-aligned boxes. Colliders with `off = true` are ignored (opened doors, cages).
 */
export const WORLD_R = 80;

const C = (h) => new THREE.Color(h);
const pick = (arr, n) => arr[Math.min(arr.length - 1, Math.floor(n * arr.length))];

// ── Terrain ───────────────────────────────────────────────────
function rawHeight(type, x, z) {
  const s = Math.sin, c = Math.cos;
  switch (type) {
    case 'hills':
      return s(x * 0.045 + 0.5) * c(z * 0.05) * 2.4 + s(x * 0.11 + 1.3) * s(z * 0.09 + 0.7) * 0.7 + s((x - z) * 0.025) * 1.6;
    case 'mountain':
      return s(x * 0.04 + 0.5) * c(z * 0.045) * 3.2 + s(x * 0.1 + 1.3) * s(z * 0.085 + 0.7) * 1.0 + s((x + z) * 0.03) * 2.0;
    case 'dunes':
      return s(x * 0.07 + s(z * 0.04) * 2.2) * 1.6 + s(z * 0.05 + x * 0.015) * 1.3 + s((x + z) * 0.11) * 0.3;
    case 'rocky':
      return s(x * 0.05) * c(z * 0.06) * 2 + Math.abs(s(x * 0.17 + 1) * s(z * 0.15)) * 0.9 - 0.4;
    default:
      return 0;
  }
}

function makeGround(level, pools) {
  const R = WORLD_R, type = level.terrain;
  const flats = [];
  const edgeH = type === 'flat' ? 0 : 20;
  const f = (x, z) => {
    const d = Math.hypot(x, z);
    let h = rawHeight(type, x, z) * smoothstep(8, 24, d);
    for (const fl of flats) {
      const dd = Math.hypot(x - fl.x, z - fl.z);
      if (dd < fl.r + 8) h = lerp(fl.h, h, smoothstep(fl.r, fl.r + 8, dd));
    }
    for (const p of pools) {
      const dd = Math.hypot(x - p.x, z - p.z);
      if (dd < p.r + 2.5) h = lerp(p.floor, h, smoothstep(p.r - 0.4, p.r + 2.5, dd));
    }
    const e = smoothstep(R - 2, R + 22, d);
    return h + e * e * edgeH;
  };
  f.addFlat = (x, z, r) => flats.push({ x, z, r, h: f(x, z) });
  f.addPool = (x, z, r, depth) => {
    const floor = f(x, z) - depth;
    const p = { x, z, r, floor, lavaY: floor + 0.3 };
    pools.push(p);
    return p;
  };
  return f;
}

// ── Geometry batching ─────────────────────────────────────────
function mergeGeos(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

class Batcher {
  constructor(cell = 28) {
    this.cell = cell;
    this.groups = new Map();
  }

  add(geo, layer) {
    const a = geo.attributes.position;
    const cx = (a.getX(0) + a.getX(a.count - 1)) / 2, cz = (a.getZ(0) + a.getZ(a.count - 1)) / 2;
    const key = `${layer}|${Math.floor(cx / this.cell)}|${Math.floor(cz / this.cell)}`;
    if (!this.groups.has(key)) this.groups.set(key, []);
    this.groups.get(key).push(geo);
  }

  build(mat) {
    const out = { solid: [], decor: [] };
    for (const [key, geos] of this.groups) {
      const layer = key.split('|')[0];
      const m = new THREE.Mesh(mergeGeos(geos), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      out[layer].push(m);
    }
    return out;
  }
}

function swirlTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, 'rgba(40,20,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 6;
  for (let a = 0; a < 3; a++) {
    g.beginPath();
    for (let t = 0; t < 1; t += 0.01) {
      const ang = a * 2.094 + t * 7, r = t * 118;
      g.lineTo(128 + Math.cos(ang) * r, 128 + Math.sin(ang) * r);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Level builder ─────────────────────────────────────────────
export function buildWorld(level, seed = 1, { lite = false } = {}) {
  const rand = mulberry32(seed * 7919 + level.id.charCodeAt(0) * 131);
  const R = WORLD_R;
  const T = {};
  for (const [k, v] of Object.entries(level.pal)) T[k] = typeof v[0] === 'string' ? v.map(C) : v;
  const F = level.flora;
  const group = new THREE.Group();
  const batch = new Batcher();
  const circles = [], boxes = [], perches = [], moonSpots = [], tunaSpots = [], glowSpots = [], camps = [], pools = [];
  const keep = [], placed = [];
  const g = makeGround(level, pools);

  const add = (geo, color, layer = 'solid') =>
    batch.add(paint(geo, typeof color === 'function' ? color : () => color), layer);
  const isFree = (x, z, r) =>
    Math.hypot(x, z) < R - 2
    && keep.every((k) => Math.hypot(x - k.x, z - k.z) > k.r + r)
    && placed.every((k) => Math.hypot(x - k.x, z - k.z) > k.r + r)
    && pools.every((p) => Math.hypot(x - p.x, z - p.z) > p.r + 2.5 + r);

  // ── Trails from spawn to every POI and the gate ──
  const targets = [...level.pois, level.gate];
  const paths = [];
  for (const L of targets) {
    const len = Math.hypot(L.x, L.z);
    const w = (rand() - 0.5) * 0.35;
    const mx = L.x / 2 - (L.z / len) * w * len, mz = L.z / 2 + (L.x / len) * w * len;
    paths.push([0, 0, mx, mz], [mx, mz, L.x, L.z]);
  }
  const segDist = (x, z, [ax, az, bx, bz]) => {
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  };
  const pathDist = (x, z) => {
    let m = Infinity;
    for (const s of paths) m = Math.min(m, segDist(x, z, s));
    return m;
  };

  // ── Flatten POI sites, dig lava pools ──
  const FLAT_R = { camp: 11, cave: 9, tower: 6, pyramid: 13, rooftops: 13, spiral: 4, isles: 6, oasis: 9 };
  g.addFlat(level.gate.x, level.gate.z, 7);
  for (const P of [...level.pois, ...(level.extras ?? [])]) {
    if (FLAT_R[P.type]) g.addFlat(P.x, P.z, FLAT_R[P.type]);
    keep.push({ x: P.x, z: P.z, r: (FLAT_R[P.type] ?? 10) + 4 });
  }
  keep.push({ x: level.gate.x, z: level.gate.z, r: 9 }, { x: 0, z: 0, r: 11 });
  if (level.lava) {
    for (const P of level.pois) if (P.type === 'lavacross') P.pool = g.addPool(P.x, P.z, 10, 1.4);
    for (let i = 0, tries = 0; i < F.pools && tries < 400; tries++) {
      const a = rand() * Math.PI * 2, r = 16 + rand() * (R - 22);
      const x = Math.cos(a) * r, z = Math.sin(a) * r, pr = 3 + rand() * 3.5;
      if (!isFree(x, z, pr) || pathDist(x, z) < pr + 2.5) continue;
      g.addPool(x, z, pr, 1.0);
      i++;
    }
  }

  // ── Terrain mesh ──
  const size = (R + 40) * 2, seg = 96;
  const tg = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const tp = tg.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setY(i, g(tp.getX(i), tp.getZ(i)));
  const cityRoad = (x, z) => {
    const mx = Math.abs(((x + 8) % 16 + 16) % 16 - 8), mz = Math.abs(((z + 8) % 16 + 16) % 16 - 8);
    return mx < 3 || mz < 3 ? 'road' : mx < 4 || mz < 4 ? 'walk' : null;
  };
  const terrain = new THREE.Mesh(paint(tg, (p) => {
    const d = Math.hypot(p.x, p.z);
    const n = hash(p.x * 0.71 + p.z * 1.37);
    if (d > R + 1) return pick(T.hill, n);
    if (F.city) {
      if (d < 8) return pick(T.ground, n);
      const r = cityRoad(p.x, p.z);
      return r === 'road' ? pick(T.path, n) : r === 'walk' ? C('#b8b4ac') : pick(T.ground, n);
    }
    for (const pl of pools) if (Math.hypot(p.x - pl.x, p.z - pl.z) < pl.r + 1.2) return C('#1e1414');
    if (d < 7 || pathDist(p.x, p.z) < 1.5) return pick(T.path, n);
    if (n > 0.9) return pick(T.litter, hash(p.z));
    return pick(T.ground, n);
  }, 0.1), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
  terrain.receiveShadow = true;
  group.add(terrain);

  // ── Generic builders ──
  const solidBox = (cx, cz, w, d, h, y0, color, { collide = true, layer = 'solid', seg = 1 } = {}) => {
    const geo = new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w / seg)), Math.max(1, Math.round(h / seg)), Math.max(1, Math.round(d / seg)));
    geo.translate(cx, y0 + h / 2, cz);
    add(geo, color, layer);
    if (collide) {
      const b = { min: new THREE.Vector3(cx - w / 2, y0, cz - d / 2), max: new THREE.Vector3(cx + w / 2, y0 + h, cz + d / 2) };
      boxes.push(b);
      return b;
    }
    return null;
  };
  const stoneColor = (top) => (p) => (p.y > top - 0.01 ? pick(T.stoneTop, hash(p.x * 3.1 + p.z)) : pick(T.stone, hash(Math.floor(p.y * 2) + p.x * 0.3 + p.z * 0.7)));

  const rock = (x, z, s, collide = true) => {
    const gy = g(x, z);
    const snowy = level.id === 'winter';
    add(new THREE.DodecahedronGeometry(s, 0).scale(1, 0.7, 1).rotateY(rand() * 6).translate(x, gy + s * 0.3, z),
      (p) => (snowy && p.y > gy + s * 0.55 ? C('#f4f8fc') : pick(T.rock, hash(p.x + p.y * 3 + p.z * 7))), collide ? 'solid' : 'decor');
    if (collide) {
      circles.push({ x, z, r: s * 0.82, y0: gy - 2, y1: gy + s * 0.95 });
      placed.push({ x, z, r: s + 0.5 });
      if (s > 0.8) perches.push(new THREE.Vector3(x, gy + s * 0.95, z));
    }
    return gy + s * 0.95;
  };

  const mushroom = (x, z, s, cap) => {
    const gy = g(x, z);
    add(new THREE.CylinderGeometry(0.05 * s, 0.07 * s, 0.26 * s, 5).translate(x, gy + 0.13 * s, z), C('#f1e9d8'), 'decor');
    add(new THREE.SphereGeometry(0.17 * s, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, gy + 0.24 * s, z), cap, 'decor');
  };

  const bush = (x, z, cols) => {
    const gy = g(x, z);
    for (let j = 0; j < 3; j++) {
      add(new THREE.IcosahedronGeometry(0.45 + rand() * 0.35, 0).translate(x + (rand() - 0.5) * 1.1, gy + 0.3, z + (rand() - 0.5) * 1.1), pick(cols, rand()), 'decor');
    }
  };

  const LEAF = {
    oak: ['#4a8f3e', '#57a048', '#3f8035'].map(C),
    birch: ['#9bcf5a', '#8cc24f', '#a8d867'].map(C),
    autumn: ['#e08a3c', '#d1772f', '#eba24f'].map(C),
    pine: ['#2f6b45', '#3a7a50', '#28603d'].map(C),
    palm: ['#5f9a3c', '#6eab46', '#548a34'].map(C),
  };
  const snow = C('#f4f8fc');

  /** Branches radiating from a trunk top (bare/dead trees). */
  const branches = (x, z, baseY, s, col, tips) => {
    const n = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2 + rand();
      const tilt = 0.5 + rand() * 0.5;
      const len = (1.2 + rand() * 0.9) * s;
      const y = baseY - rand() * 1.2 * s;
      add(new THREE.CylinderGeometry(0.04 * s, 0.1 * s, len, 4).translate(0, len / 2, 0).rotateZ(tilt).rotateY(yaw).translate(x, y, z), col, 'decor');
      if (tips) {
        const tx = x - Math.sin(tilt) * len * Math.cos(yaw), tz = z + Math.sin(tilt) * len * Math.sin(yaw);
        add(new THREE.IcosahedronGeometry(0.14 * s, 0).translate(tx, y + Math.cos(tilt) * len, tz), tips, 'decor');
      }
    }
  };

  const regularTree = (x, z, s, kind, collide = true) => {
    const gy = g(x, z);
    const layer = collide ? 'solid' : 'decor';
    let trunkH = 2.6 * s, top = null, r = 0.27 * s, climbable = true;
    if (kind === 'pine' || kind === 'snowpine') {
      trunkH = 2.2 * s;
      add(new THREE.CylinderGeometry(0.2 * s, 0.32 * s, trunkH + 0.6, 6, 3).translate(x, gy + trunkH / 2 - 0.3, z), pick(T.bark, rand()), layer);
      [[0.55, 1.7], [1.0, 1.4], [1.45, 1.05], [1.85, 0.7]].forEach(([y, rr], i) => {
        const cy = gy + trunkH * y + 1.0 * s;
        add(new THREE.ConeGeometry(rr * s, 1.8 * s, 7).translate(x, cy, z), kind === 'snowpine' ? pick(T.leaves, (i % 3) / 3) : pick(LEAF.pine, (i % 3) / 3), 'decor');
        if (kind === 'snowpine') add(new THREE.ConeGeometry(rr * s * 0.55, 0.9 * s, 7).translate(x, cy + 0.48 * s, z), snow, 'decor');
      });
      top = gy + Math.max(0.8, trunkH * 0.55);
    } else if (kind === 'bare' || kind === 'dead') {
      trunkH = 3.2 * s;
      const col = kind === 'dead' ? pick(T.bark, rand()) : pick(T.bark, rand());
      add(new THREE.CylinderGeometry(0.16 * s, 0.3 * s, trunkH + 0.5, 6, 3).translate(x, gy + trunkH / 2 - 0.25, z), col, layer);
      branches(x, z, gy + trunkH, s, col, kind === 'dead' ? C('#ff7a2a') : snow);
      top = gy + trunkH - 0.6;
    } else if (kind === 'cactus') {
      trunkH = (2.4 + rand()) * s;
      const green = [C('#5f9a3c'), C('#548a34'), C('#6aa846')];
      add(new THREE.CylinderGeometry(0.3 * s, 0.34 * s, trunkH, 8, 3).translate(x, gy + trunkH / 2, z), (p) => pick(green, hash(p.x * 9 + p.z * 5)), layer);
      add(new THREE.SphereGeometry(0.3 * s, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, gy + trunkH, z), green[0], layer);
      for (const sd of [-1, 1]) {
        if (rand() < 0.3) continue;
        const ay = gy + trunkH * (0.4 + rand() * 0.25), ax = x + sd * 0.6 * s;
        add(new THREE.CylinderGeometry(0.18 * s, 0.18 * s, 0.6 * s, 6).rotateZ(Math.PI / 2).translate(x + sd * 0.35 * s, ay, z), green[1], 'decor');
        add(new THREE.CylinderGeometry(0.18 * s, 0.18 * s, 1.1 * s, 6).translate(ax, ay + 0.5 * s, z), green[1], 'decor');
      }
      r = 0.32 * s;
      climbable = false;
    } else if (kind === 'palm') {
      trunkH = 4.2 * s;
      const lean = (rand() - 0.5) * 0.25, yaw = rand() * 6;
      let px = x, pz = z;
      for (let i = 0; i < 6; i++) {
        const segH = trunkH / 6;
        add(new THREE.CylinderGeometry(0.2 * s, 0.24 * s, segH * 1.05, 6).translate(px, gy + segH * (i + 0.5), pz), i % 2 ? C('#a68052') : C('#8f6a40'), layer);
        px += Math.cos(yaw) * lean * i * 0.1;
        pz += Math.sin(yaw) * lean * i * 0.1;
      }
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        add(new THREE.BoxGeometry(0.5 * s, 0.05, 2.4 * s).translate(0, 0, 1.2 * s).rotateX(0.45).rotateY(a).translate(px, gy + trunkH, pz), pick(LEAF.palm, rand()), 'decor');
      }
      top = gy + trunkH - 0.8;
      r = 0.22 * s;
      perches.push(new THREE.Vector3(px, gy + trunkH + 0.1, pz));
    } else if (kind === 'deadbush') {
      add(new THREE.IcosahedronGeometry(0.5 * s, 0).translate(x, gy + 0.35 * s, z), C('#a08458'), 'decor');
      return;
    } else if (kind === 'basalt') {
      for (let i = 0; i < 3; i++) {
        const bx = x + (rand() - 0.5) * 1.4, bz = z + (rand() - 0.5) * 1.4, h = (1 + rand() * 2.2) * s, br = 0.5 + rand() * 0.2;
        add(new THREE.CylinderGeometry(br, br * 1.05, h + 1, 6).translate(bx, g(bx, bz) + h / 2 - 0.5, bz), (p) => (p.y > g(bx, bz) + h - 0.55 ? pick(T.stoneTop, rand()) : pick(T.rock, hash(p.y * 3))), layer);
        if (collide) circles.push({ x: bx, z: bz, r: br, y0: g(bx, bz) - 2, y1: g(bx, bz) + h });
      }
      placed.push({ x, z, r: 2 });
      return;
    } else {
      const leaves = LEAF[kind] ?? T.leaves;
      add(new THREE.CylinderGeometry(0.2 * s, 0.32 * s, trunkH + 0.6, 6, 3).translate(x, gy + trunkH / 2 - 0.3, z),
        (p) => (kind === 'birch' ? (hash(p.y * 9 + p.x) > 0.8 ? C('#3a3530') : C('#ece8de')) : pick(T.bark, hash(p.y * 3 + p.z))), layer);
      [[0, 1.0, 0, 1.5], [0.8, 0.6, 0.35, 1.0], [-0.7, 0.7, -0.3, 1.05], [0.1, 1.8, -0.1, 0.95]].forEach(([ox, oy, oz, rr], i) => {
        add(new THREE.IcosahedronGeometry(rr * s, 0).translate(x + ox * s, gy + trunkH + oy * s, z + oz * s), leaves[i % 3], 'decor');
      });
      top = gy + trunkH - 0.5;
    }
    if (!collide) return;
    circles.push({ x, z, r, y0: gy - 2, y1: gy + 60, climb: climbable ? { top, mountY: null } : null });
    placed.push({ x, z, r: 1.4 * s });
  };

  const greatTree = (x, z, height, { tr = 0.8, platR = 2.4, leaves = true, bark = T.greatBark, hex = false } = {}) => {
    const gy = g(x, z);
    const top = gy + height;
    const h = top - 0.3 - (gy - 0.5);
    add(new THREE.CylinderGeometry(tr * 0.85, tr * 1.15, h, hex ? 6 : 9, Math.ceil(h / 1.2)).translate(x, gy - 0.5 + h / 2, z),
      (p) => pick(bark, hash(Math.floor(p.y * 1.3) + p.x * 0.1)));
    add(new THREE.CylinderGeometry(platR, platR * 0.78, 0.5, hex ? 6 : 11).translate(x, top - 0.25, z),
      (p) => (p.y > top - 0.01 ? pick(T.top, hash(p.x * 3 + p.z)) : pick(T.side, hash(p.y * 4 + p.x))));
    if (leaves) {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rand() * 0.5;
        add(new THREE.IcosahedronGeometry(0.9 + rand() * 0.5, 0).translate(x + Math.cos(a) * (platR + 0.4), top - 0.9 + rand() * 0.3, z + Math.sin(a) * (platR + 0.4)), pick(T.leaves, rand()), 'decor');
      }
      for (const a of [rand() * 6, rand() * 6]) {
        const bx = x + Math.cos(a) * platR * 0.7, bz = z + Math.sin(a) * platR * 0.7;
        add(new THREE.CylinderGeometry(0.12, 0.2, 5.5, 5).translate(bx, top + 2.75, bz), pick(bark, 0.2), 'decor');
        add(new THREE.IcosahedronGeometry(1.8, 0).translate(bx, top + 6, bz), pick(T.leaves, rand()), 'decor');
      }
    }
    circles.push({ x, z, r: tr, y0: gy - 2, y1: top - 0.5, climb: { top: top - 1.55, mountY: top, platR } });
    circles.push({ x, z, r: platR, y0: top - 0.5, y1: top });
    perches.push(new THREE.Vector3(x + platR - 0.5, top, z));
    return top;
  };

  const pad = (x, y, z, r, style) => {
    if (style === 'isle') {
      add(new THREE.CylinderGeometry(r, r * 0.92, 0.35, 9).translate(x, y - 0.175, z),
        (p) => (p.y > y - 0.01 ? pick(T.isleTop, hash(p.x * 3 + p.z)) : pick(T.isleSide, hash(p.y * 7 + p.x))));
      add(new THREE.ConeGeometry(r * 0.88, r * 1.4, 7).rotateX(Math.PI).translate(x, y - 0.35 - r * 0.7, z), pick(T.isleSide, rand()));
      glowSpots.push(new THREE.Vector3(x, y - 0.4 - r * 1.4, z));
      circles.push({ x, z, r, y0: y - 0.7, y1: y });
    } else if (style === 'shelf') {
      add(new THREE.CylinderGeometry(r, r * 0.6, 0.3, 9).translate(x, y - 0.15, z),
        (p) => (p.y > y - 0.01 ? pick(T.shelfTop, hash(p.x * 5 + p.z * 3)) : pick(T.shelfSide, hash(p.y * 7))));
      circles.push({ x, z, r, y0: y - 0.3, y1: y });
    } else {
      add(new THREE.CylinderGeometry(r, r * 0.85, 0.35, 9).translate(x, y - 0.175, z),
        (p) => (p.y > y - 0.01 ? pick(T.top, hash(p.x * 3 + p.z)) : pick(T.side, hash(p.y * 4))));
      for (const a of [0.7, 3.8]) {
        add(new THREE.CylinderGeometry(0.03, 0.03, 6, 3).translate(x + Math.cos(a) * r * 0.8, y + 3, z + Math.sin(a) * r * 0.8), C('#4e7d34'), 'decor');
      }
      circles.push({ x, z, r, y0: y - 0.35, y1: y });
    }
    if (rand() < 0.4) perches.push(new THREE.Vector3(x, y, z));
  };

  /** Hexagonal column from a lava floor (or ground) up to `top`. */
  const pillar = (x, z, r, top, floor) => {
    add(new THREE.CylinderGeometry(r, r * 1.08, top - floor + 1, 6).translate(x, (top + floor - 1) / 2, z),
      (p) => (p.y > top - 0.01 ? pick(T.stoneTop, hash(p.x + p.z)) : pick(T.rock, hash(p.y * 2 + p.x))));
    circles.push({ x, z, r, y0: floor - 2, y1: top });
  };

  /** Building with window bands; optional climbable drainpipe on the side facing (fx, fz). */
  const building = (cx, cz, w, d, h, { pipe = false, layer = 'solid', collide = true } = {}) => {
    const gy = g(cx, cz);
    const base = pick(T.buildings, rand());
    const win = C('#9cc4e8'), roof = C('#6e6e78'), trim = base.clone().multiplyScalar(0.85);
    const geo = new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w)), Math.max(1, Math.round(h / 0.8)), Math.max(1, Math.round(d)));
    geo.translate(cx, gy + h / 2, cz);
    add(geo, (p) => {
      if (p.y > gy + h - 0.01) return roof;
      const band = Math.floor((p.y - gy) / 0.8);
      const col = Math.floor((p.x + p.z) * 1.0);
      if (band > 0 && band % 2 === 1 && col % 2 === 0 && p.y < gy + h - 0.5) return win;
      return band === 0 ? trim : base;
    }, layer);
    // roof ledge
    add(new THREE.BoxGeometry(w + 0.3, 0.25, d + 0.3).translate(cx, gy + h + 0.05, cz), trim, 'decor');
    if (!collide) return gy + h;
    boxes.push({ min: new THREE.Vector3(cx - w / 2, gy - 1, cz - d / 2), max: new THREE.Vector3(cx + w / 2, gy + h, cz + d / 2) });
    perches.push(new THREE.Vector3(cx + (rand() - 0.5) * w * 0.6, gy + h, cz + (rand() - 0.5) * d * 0.6));
    if (pipe) {
      // pick the face pointing most toward the world origin
      const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [fx, fz] = faces.sort((a, b) => (Math.hypot(cx + a[0] * w - 0, cz + a[1] * d) - Math.hypot(cx + b[0] * w, cz + b[1] * d)))[0];
      const off = (rand() - 0.5) * 0.5;
      const px = cx + fx * (w / 2 + 0.18) + (fz !== 0 ? off * w : 0), pz = cz + fz * (d / 2 + 0.18) + (fx !== 0 ? off * d : 0);
      add(new THREE.CylinderGeometry(0.1, 0.1, h + 0.2, 6).translate(px, gy + h / 2, pz), C('#7a8088'));
      circles.push({ x: px, z: pz, r: 0.12, y0: gy - 2, y1: gy + h - 0.6, climb: { top: gy + h - 1.1, mountY: gy + h, mountTo: { x: cx, z: cz } }, thin: true });
    }
    return gy + h;
  };

  const lampPost = (x, z) => {
    const gy = g(x, z);
    add(new THREE.CylinderGeometry(0.08, 0.12, 4.2, 6).translate(x, gy + 2.1, z), C('#3a3d48'));
    add(new THREE.BoxGeometry(0.5, 0.25, 0.5).translate(x, gy + 4.3, z), C('#ffe8a0'), 'decor');
    circles.push({ x, z, r: 0.14, y0: gy - 2, y1: gy + 4.4, climb: { top: gy + 3.0, mountY: null }, thin: true });
    perches.push(new THREE.Vector3(x, gy + 4.45, z));
  };

  // ── Cage (opens when its camp is cleared) ──
  const cageMat = new THREE.MeshStandardMaterial({ color: '#d8b04a', metalness: 0.6, roughness: 0.35, flatShading: true });
  const makeCage = (x, y, z) => {
    const cage = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4), cageMat);
      bar.position.set(Math.cos(a) * 0.65, 0.9, Math.sin(a) * 0.65);
      bar.castShadow = true;
      cage.add(bar);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.06, 4, 12).rotateX(Math.PI / 2), cageMat);
    ring.position.y = 1.8;
    cage.add(ring);
    cage.position.set(x, y, z);
    group.add(cage);
    const col = { x, z, r: 0.75, y0: y - 1, y1: y + 1.85 };
    circles.push(col);
    return { mesh: cage, col };
  };

  const addCamp = (x, z, y, r, count) => {
    const camp = { x, z, y, r, spawns: [], cage: null, moon: -1, cleared: false };
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.5, rr = r * (0.45 + rand() * 0.35);
      camp.spawns.push({ type: i % 2 === 0 || i === count - 1 && rand() < 0.5 ? 'blob' : 'beetle', x: x + Math.cos(a) * rr, z: z + Math.sin(a) * rr });
    }
    camps.push(camp);
    return camp;
  };

  // ── Points of interest ──
  const POI = {
    canopy(P) {
      const dx = Math.cos(P.rot ?? 0), dz = Math.sin(P.rot ?? 0), px = -dz, pz = dx;
      const heights = [7, 8.5, 10];
      const pts = [-1, 0, 1].map((k) => [P.x + dx * 11 * k, P.z + dz * 11 * k]);
      const tops = pts.map(([x, z], i) => greatTree(x, z, heights[i]));
      for (let gi = 0; gi < 2; gi++) {
        for (const j of [1, 2]) {
          const u = j / 3;
          const side = (j === 1 ? 1 : -1) * (gi === 0 ? 1 : -1) * 1.1;
          pad(lerp(pts[gi][0], pts[gi + 1][0], u) + px * side, lerp(tops[gi], tops[gi + 1], u) + 0.35, lerp(pts[gi][1], pts[gi + 1][1], u) + pz * side, 1.05, 'hang');
        }
      }
      for (const [x, z] of pts) keep.push({ x, z, r: 4.5 });
      moonSpots.push({ p: new THREE.Vector3(pts[2][0], tops[2], pts[2][1]) });
      tunaSpots.push(new THREE.Vector3(pts[1][0], tops[1], pts[1][1]));
    },
    spiral(P) {
      const basalt = P.style === 'basalt';
      const tr = 1.25, n = 12, step = 1.1;
      const gy = g(P.x, P.z);
      const top = greatTree(P.x, P.z, step * (n + 1), { tr, platR: 1.8, leaves: !basalt && level.id !== 'winter', bark: basalt ? T.rock : T.greatBark, hex: basalt });
      const a0 = rand() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const a = a0 + i * 0.75;
        const x = P.x + Math.cos(a) * (tr + 1.0), z = P.z + Math.sin(a) * (tr + 1.0);
        pad(x, gy + step * (i + 1), z, 0.9, 'shelf');
        if (i === 5) tunaSpots.push(new THREE.Vector3(x, gy + step * (i + 1), z));
      }
      moonSpots.push({ p: new THREE.Vector3(P.x, top, P.z) });
    },
    isles(P) {
      const rockTop = rock(P.x, P.z, 1.6);
      const a0 = rand() * Math.PI * 2;
      let last;
      for (let i = 0; i < 7; i++) {
        const a = a0 + i * 0.95;
        last = new THREE.Vector3(P.x + Math.cos(a) * 3.6, rockTop + 0.95 * (i + 1), P.z + Math.sin(a) * 3.6);
        pad(last.x, last.y, last.z, 1.1, 'isle');
        if (i === 3) tunaSpots.push(last.clone());
      }
      moonSpots.push({ p: last });
    },
    tower(P) {
      const gy = g(P.x, P.z);
      const H = P.height ?? 11;
      const half = 2;
      const top = gy + H;
      const style = P.style;
      const colorFn = (p) => {
        if (p.y > top - 0.01) return pick(T.stoneTop, hash(p.x + p.z));
        if (style === 'ruin' && p.y < gy + 2 && hash(p.x * 3 + p.y + p.z) > 0.6) return pick(T.top, rand());
        if (style === 'clock' && Math.floor((p.y - gy) / 0.5) % 6 === 0) return C('#e8e0d0');
        return pick(T.stone, hash(Math.floor((p.y - gy) * 2) + Math.floor(p.x + p.z)));
      };
      solidBox(P.x, P.z, half * 2, half * 2, H, gy - 0.5, colorFn, { seg: 0.5 });
      // stepping stones spiralling around the outside
      const a = half + 0.75;
      const n = Math.ceil(H / 1.05) - 1;
      const stepH = H / (n + 1);
      const per = (s) => {
        const L = 2 * a, k = ((Math.floor(s / L) % 4) + 4) % 4, t = (s % L) - a;
        return [[t, a], [a, -t], [-t, -a], [-a, t]][k];
      };
      const startSide = Math.atan2(-P.z, -P.x);
      const s0 = ((startSide / (Math.PI * 2)) * 8 * a + 8 * a) % (8 * a);
      for (let i = 0; i < n; i++) {
        const [ox, oz] = per(s0 + i * 2.05);
        const ty = gy + stepH * (i + 1);
        solidBox(P.x + ox, P.z + oz, 1.4, 1.4, 0.5, ty - 0.5, colorFn);
        if (i === Math.floor(n / 2)) tunaSpots.push(new THREE.Vector3(P.x + ox, ty, P.z + oz));
        if (rand() < 0.3) perches.push(new THREE.Vector3(P.x + ox, ty, P.z + oz));
      }
      // crenellations / roof decor
      for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        add(new THREE.BoxGeometry(0.6, style === 'watch' ? 2.4 : 0.6, 0.6).translate(P.x + cx * (half - 0.3), top + (style === 'watch' ? 1.2 : 0.3), P.z + cz * (half - 0.3)), pick(T.stone, rand()), 'decor');
      }
      if (style === 'watch') add(new THREE.ConeGeometry(3.2, 2, 4).rotateY(Math.PI / 4).translate(P.x, top + 3.4, P.z), C('#7a4a3a'), 'decor');
      if (style === 'obelisk') glowSpots.push(new THREE.Vector3(P.x, top + 2.6, P.z));
      if (style === 'clock') {
        for (const [fx, fz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const disc = new THREE.CircleGeometry(1.2, 12);
          if (fx) disc.rotateY(fx * Math.PI / 2); else if (fz < 0) disc.rotateY(Math.PI);
          add(disc.translate(P.x + fx * (half + 0.02), top - 2, P.z + fz * (half + 0.02)), C('#fbf6e8'), 'decor');
        }
      }
      moonSpots.push({ p: new THREE.Vector3(P.x, top, P.z) });
      perches.push(new THREE.Vector3(P.x + 1, top, P.z + 1));
    },
    camp(P) {
      const gy = g(P.x, P.z);
      const park = P.style === 'park';
      const camp = addCamp(P.x, P.z, gy, 9, level.enemy.count);
      // ring of stakes / hedges
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        const fromOrigin = Math.abs(Math.atan2(Math.sin(a - Math.atan2(-P.z, -P.x)), Math.cos(a - Math.atan2(-P.z, -P.x))));
        if (fromOrigin < 0.35) continue; // entrance facing the spawn
        const x = P.x + Math.cos(a) * 10, z = P.z + Math.sin(a) * 10;
        if (park) bush(x, z, T.leaves);
        else add(new THREE.CylinderGeometry(0.12, 0.16, 1.5, 5).translate(x, g(x, z) + 0.6, z), pick(T.side, rand()), 'decor');
      }
      // tents / props
      for (const a of [rand() * 6, rand() * 6 + 2]) {
        const x = P.x + Math.cos(a) * 7.2, z = P.z + Math.sin(a) * 7.2;
        if (park) {
          regularTree(x, z, 1.1, 'oak');
        } else {
          add(new THREE.ConeGeometry(1.4, 1.9, 4).rotateY(rand()).translate(x, g(x, z) + 0.95, z), pick(T.isleSide, rand()));
          circles.push({ x, z, r: 1.1, y0: g(x, z) - 1, y1: g(x, z) + 1.2 });
        }
      }
      if (park) {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4;
          lampPost(P.x + Math.cos(a) * 8.6, P.z + Math.sin(a) * 8.6);
        }
      }
      solidBox(P.x, P.z, 1.8, 1.8, 0.6, gy - 0.2, stoneColor(gy + 0.4));
      camp.cage = makeCage(P.x, gy + 0.4, P.z);
      camp.moon = moonSpots.length;
      moonSpots.push({ p: new THREE.Vector3(P.x, gy + 0.4, P.z), lock: camps.length - 1 });
      tunaSpots.push(new THREE.Vector3(P.x + 6, g(P.x + 6, P.z + 3), P.z + 3));
    },
    cave(P) {
      const gy = g(P.x, P.z);
      const half = 6, wallH = 4.5, t = 1;
      const col = (p) => (p.y > gy + wallH + 0.7 ? snow : pick(T.rock, hash(Math.floor(p.y * 2) + p.x * 0.5 + p.z)));
      // which side faces the spawn?
      const toO = Math.abs(P.x) > Math.abs(P.z) ? (P.x > 0 ? 'W' : 'E') : (P.z > 0 ? 'N' : 'S');
      const wall = (side) => {
        const open = side === toO;
        const along = (len, off) => {
          if (side === 'N' || side === 'S') solidBox(P.x + off, P.z + (side === 'N' ? -half : half), len, t, wallH, gy - 0.5, col, { seg: 1 });
          else solidBox(P.x + (side === 'W' ? -half : half), P.z + off, t, len, wallH, gy - 0.5, col, { seg: 1 });
        };
        if (open) {
          along(half - 1.6, -(half + 1.6) / 2 - 0.0);
          along(half - 1.6, (half + 1.6) / 2);
        } else along(half * 2 + t, 0);
      };
      ['N', 'S', 'E', 'W'].forEach(wall);
      solidBox(P.x, P.z, half * 2 + 2, half * 2 + 2, 0.9, gy + wallH - 0.5, col);
      // mound of boulders over the top, snow cap
      for (let i = 0; i < 14; i++) {
        const a = rand() * Math.PI * 2, rr = rand() * (half + 1);
        add(new THREE.DodecahedronGeometry(1.4 + rand() * 1.4, 0).translate(P.x + Math.cos(a) * rr, gy + wallH + 0.6 + rand() * 0.6, P.z + Math.sin(a) * rr), (p) => (p.y > gy + wallH + 1.3 ? snow : pick(T.rock, rand())), 'decor');
      }
      for (let i = 0; i < 10; i++) {
        const a = rand() * Math.PI * 2, rr = half - 0.8 - rand() * 1.5;
        glowSpots.push(new THREE.Vector3(P.x + Math.cos(a) * rr, gy + 0.3, P.z + Math.sin(a) * rr));
      }
      const light = new THREE.PointLight('#8fdcff', 12, 14, 1.4);
      light.position.set(P.x, gy + 3, P.z);
      group.add(light);
      const camp = addCamp(P.x, P.z, gy, 4.6, level.enemy.count);
      solidBox(P.x, P.z, 1.8, 1.8, 0.6, gy - 0.2, stoneColor(gy + 0.4));
      camp.cage = makeCage(P.x, gy + 0.4, P.z);
      camp.moon = moonSpots.length;
      moonSpots.push({ p: new THREE.Vector3(P.x, gy + 0.4, P.z), lock: camps.length - 1 });
      tunaSpots.push(new THREE.Vector3(P.x + half + 2.5, g(P.x + half + 2.5, P.z), P.z));
    },
    pyramid(P) {
      const gy = g(P.x, P.z);
      const layers = 8, lh = 1.15;
      for (let i = 0; i < layers; i++) {
        const s = 22 - i * 2.6;
        const top = gy + (i + 1) * lh;
        solidBox(P.x, P.z, s, s, lh + (i === 0 ? 0.5 : 0), top - lh - (i === 0 ? 0.5 : 0), stoneColor(top), { seg: 1.6 });
        if (i === 4) tunaSpots.push(new THREE.Vector3(P.x + s / 2 - 0.6, top, P.z + s / 2 - 0.6));
      }
      const top = gy + layers * lh;
      glowSpots.push(new THREE.Vector3(P.x - 1.2, top + 0.3, P.z - 1.2), new THREE.Vector3(P.x + 1.2, top + 0.3, P.z + 1.2));
      moonSpots.push({ p: new THREE.Vector3(P.x, top, P.z) });
      perches.push(new THREE.Vector3(P.x + 6, gy + 4 * lh, P.z));
    },
    rooftops(P) {
      // 3×3 block of buildings; heights climb in a snake so you can hop roof to roof
      const order = [[-1, -1], [0, -1], [1, -1], [1, 0], [0, 0], [-1, 0], [-1, 1], [0, 1], [1, 1]];
      const start = Math.hypot(P.x - 6.5, P.z - 6.5) < Math.hypot(P.x + 6.5, P.z + 6.5) ? order.slice() : order.slice().reverse();
      let last;
      start.forEach(([i, j], k) => {
        const x = P.x + i * 6.5, z = P.z + j * 6.5;
        const top = building(x, z, 5, 5, 3.2 + k * 1.2, { pipe: k === 0 || k === 4 });
        if (k === 4) tunaSpots.push(new THREE.Vector3(x, top, z));
        last = new THREE.Vector3(x, top, z);
        if (k > 0 && k < 8 && rand() < 0.5) {
          solidBox(x + 1.2, z - 1.2, 1.2, 1.0, 0.8, top, C('#c9ccd4'));
        }
      });
      moonSpots.push({ p: last });
    },
    lavacross(P) {
      const pool = P.pool;
      const dir = Math.atan2(-P.z, -P.x);
      const ox = Math.cos(dir), oz = Math.sin(dir);
      const islandTop = pool.floor + 4.6;
      pillar(P.x, P.z, 2.3, islandTop, pool.floor);
      for (let i = 0; i < 4; i++) {
        const d = 9.6 - i * 2.4;
        const side = (i % 2 ? 1 : -1) * 0.6;
        const x = P.x + ox * d - oz * side, z = P.z + oz * d + ox * side;
        pillar(x, z, 0.85, pool.floor + 1.9 + i * 0.75, pool.floor);
        if (i === 2) tunaSpots.push(new THREE.Vector3(x, pool.floor + 1.9 + i * 0.75, z));
      }
      moonSpots.push({ p: new THREE.Vector3(P.x, islandTop, P.z) });
    },
    oasis(P) {
      const water = new THREE.Mesh(new THREE.CircleGeometry(5, 16).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: '#4fb3d9', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85, flatShading: true }));
      water.position.set(P.x, g(P.x, P.z) + 0.04, P.z);
      water.receiveShadow = true;
      group.add(water);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rand() * 0.4;
        regularTree(P.x + Math.cos(a) * 6.8, P.z + Math.sin(a) * 6.8, 0.9 + rand() * 0.4, 'palm');
      }
      tunaSpots.push(new THREE.Vector3(P.x, g(P.x, P.z), P.z));
    },
  };
  for (const P of level.pois) POI[P.type](P);
  for (const P of level.extras ?? []) POI[P.type](P);

  // ── Moon Gate ──
  const gate = (() => {
    const { x: gx, z: gz } = level.gate;
    const gy = g(gx, gz);
    const col = stoneColor(gy + 6.5);
    solidBox(gx, gz, 8, 3.2, 0.25, gy - 0.25, col);
    solidBox(gx - 2.5, gz, 1.3, 1.3, 6, gy, col, { seg: 0.6 });
    solidBox(gx + 2.5, gz, 1.3, 1.3, 6, gy, col, { seg: 0.6 });
    solidBox(gx, gz, 6.6, 1.5, 1.1, gy + 6, col);
    add(new THREE.TorusGeometry(0.6, 0.12, 4, 12, Math.PI * 1.3).rotateZ(0.9).translate(gx, gy + 6.55, gz + 0.8), C('#ffe29a'), 'decor');
    const doorMat = new THREE.MeshStandardMaterial({ color: '#6c6482', roughness: 0.7, flatShading: true });
    const door = new THREE.Mesh(new THREE.BoxGeometry(3.7, 5.9, 0.4), doorMat);
    door.position.set(gx, gy + 2.95, gz);
    door.castShadow = door.receiveShadow = true;
    const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16), new THREE.MeshBasicMaterial({ color: '#9ad8ff' }));
    emblem.position.set(0, 0.6, 0.21);
    door.add(emblem);
    group.add(door);
    const doorBox = { min: new THREE.Vector3(gx - 1.9, gy - 1, gz - 0.25), max: new THREE.Vector3(gx + 1.9, gy + 6, gz + 0.25) };
    boxes.push(doorBox);
    const portal = new THREE.Mesh(new THREE.CircleGeometry(1.75, 32), new THREE.MeshBasicMaterial({
      map: swirlTexture('rgba(150,120,255,0.9)'), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    }));
    portal.position.set(gx, gy + 2.6, gz);
    portal.scale.set(1, 1.45, 1);
    portal.visible = false;
    group.add(portal);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.6, 90, 8, 1, true).translate(0, 45, 0), new THREE.MeshBasicMaterial({
      color: '#ffe29a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    beam.position.set(gx, gy, gz);
    beam.visible = false;
    group.add(beam);
    return { x: gx, z: gz, y: gy, door, doorBox, emblem, portal, beam, open: false, t: 0 };
  })();

  // ── Spawn: the picnic blanket ──
  add(new THREE.BoxGeometry(2.2, 0.04, 1.7, 8, 1, 6).translate(2.6, g(2.6, 1.2) + 0.02, 1.2),
    (p) => ((Math.floor((p.x - 1.5) * 3.6) + Math.floor(p.z * 3.6)) % 2 ? C('#e24b4b') : C('#f6efe6')), 'decor');
  add(new THREE.BoxGeometry(0.6, 0.4, 0.45).translate(3.3, g(3.3, 0.8) + 0.24, 0.8), C('#b98a4e'));
  boxes.push({ min: new THREE.Vector3(3.0, -1, 0.575), max: new THREE.Vector3(3.6, g(3.3, 0.8) + 0.44, 1.025) });
  tunaSpots.push(new THREE.Vector3(2.2, g(2.2, 1.4) + 0.05, 1.4));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    perches.push(new THREE.Vector3(Math.cos(a) * 6, g(Math.cos(a) * 6, Math.sin(a) * 6), Math.sin(a) * 6));
  }

  // ── City blocks ──
  if (F.city) {
    for (let cx = -72; cx <= 72; cx += 16) {
      for (let cz = -72; cz <= 72; cz += 16) {
        if (Math.hypot(cx, cz) > R - 6) continue;
        if (keep.some((k) => Math.hypot(cx - k.x, cz - k.z) < k.r + 5)) continue;
        if (pathDist(cx, cz) < 5) {
          // small plaza with a tree instead of a building on the trails
          regularTree(cx, cz, 1.1, 'oak');
          continue;
        }
        if (rand() < 0.5) building(cx, cz, 9, 9, 4 + rand() * 9, { pipe: rand() < 0.6 });
        else for (const [ox, oz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) building(cx + ox, cz + oz, 4.2, 4.2, 3 + rand() * 7, { pipe: rand() < 0.35 });
      }
    }
    for (let x = -64; x <= 64; x += 16) {
      for (let z = -64; z <= 64; z += 16) {
        const lx = x + 3.5, lz = z + 3.5;
        if (Math.hypot(lx, lz) < R - 4 && isFree(lx, lz, 1) && Math.hypot(lx, lz) > 9) lampPost(lx, lz);
      }
    }
    for (let i = 0, tries = 0; i < 14 && tries < 400; tries++) {
      const along = rand() < 0.5, line = Math.round((rand() - 0.5) * 8) * 16, t = (rand() - 0.5) * 2 * (R - 10);
      const x = along ? t : line + 1.6, z = along ? line + 1.6 : t;
      if (!isFree(x, z, 2) || Math.hypot(x, z) < 12) continue;
      const w = along ? 3.6 : 1.7, d = along ? 1.7 : 3.6;
      const carCol = pick(['#e24b4b', '#4b8be2', '#f2c94c', '#f6efe6', '#4bc27a'].map(C), rand());
      solidBox(x, z, w, d, 0.9, g(x, z), carCol);
      solidBox(x, z, w * 0.6, d * 0.85, 0.55, g(x, z) + 0.9, C('#9cc4e8'), { collide: true });
      placed.push({ x, z, r: 2 });
      i++;
    }
    // skyline backdrop
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2, r = R + 3 + rand() * 12;
      building(Math.cos(a) * r, Math.sin(a) * r, 6 + rand() * 4, 6 + rand() * 4, 10 + rand() * 22, { collide: false, layer: 'decor' });
    }
  }

  // ── Scatter rocks, logs, trees, undergrowth ──
  for (let i = 0, tries = 0; i < F.rocks && tries < 3000; tries++) {
    const a = rand() * Math.PI * 2, r = 12 + Math.sqrt(rand()) * (R - 14);
    const x = Math.cos(a) * r, z = Math.sin(a) * r, s = 0.5 + rand() * 1.5;
    if (!isFree(x, z, s + 0.5) || pathDist(x, z) < s + 1.8) continue;
    rock(x, z, s);
    i++;
  }
  for (let i = 0, tries = 0; i < F.logs && tries < 2000; tries++) {
    const a = rand() * Math.PI * 2, r = 14 + rand() * (R - 18);
    const x = Math.cos(a) * r, z = Math.sin(a) * r, len = 3 + rand() * 2.5, alongX = rand() < 0.5;
    if (!isFree(x, z, len / 2 + 0.6) || pathDist(x, z) < len / 2 + 1.5) continue;
    const gy = g(x, z);
    const geo = new THREE.CylinderGeometry(0.38, 0.38, len, 7, 2);
    if (alongX) geo.rotateZ(Math.PI / 2); else geo.rotateX(Math.PI / 2);
    geo.translate(x, gy + 0.3, z);
    add(geo, (p) => (Math.abs(alongX ? p.x - x : p.z - z) > len / 2 - 0.02 ? C('#c8a27a') : pick(T.bark, hash(p.x + p.z * 2))));
    const hx = alongX ? len / 2 : 0.38, hz = alongX ? 0.38 : len / 2;
    boxes.push({ min: new THREE.Vector3(x - hx, gy - 1, z - hz), max: new THREE.Vector3(x + hx, gy + 0.68, z + hz) });
    placed.push({ x, z, r: len / 2 });
    perches.push(new THREE.Vector3(x, gy + 0.68, z));
    i++;
  }
  // Trees grow in groves so the forest has clearings between them
  const groves = Array.from({ length: 14 }, () => {
    const a = rand() * Math.PI * 2, r = 14 + rand() * (R - 16);
    return [Math.cos(a) * r, Math.sin(a) * r, 8 + rand() * 9];
  });
  for (let i = 0, tries = 0; i < F.trees && tries < 9000; tries++) {
    let x, z;
    if (rand() < 0.75) {
      const [gx, gz, gr] = groves[Math.floor(rand() * groves.length)];
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * gr;
      x = gx + Math.cos(a) * r;
      z = gz + Math.sin(a) * r;
    } else {
      const a = rand() * Math.PI * 2, r = 12 + Math.sqrt(rand()) * (R - 13);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
    }
    const s = 0.95 + rand() * 0.75;
    if (!isFree(x, z, 1.0 * s) || pathDist(x, z) < 2.8) continue;
    regularTree(x, z, s, pick(F.kinds, rand()));
    i++;
  }
  // backdrop ring on the hills (no collision — the player is clamped inside)
  if (!F.city) {
    for (let i = 0; i < (lite ? 90 : 150); i++) {
      const a = rand() * Math.PI * 2, r = R + 1.5 + rand() * 24;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (level.id === 'desert' || level.id === 'lava') {
        if (i % 3) continue;
        add(new THREE.CylinderGeometry(2 + rand() * 3, 4 + rand() * 4, 6 + rand() * 12, 6).translate(x, g(x, z) + 3, z), pick(T.rock, rand()), 'decor');
      } else regularTree(x, z, 1.1 + rand() * 0.9, pick(F.kinds.filter((k) => k !== 'bare') .concat(['pine']), rand()), false);
    }
  }
  for (let i = 0; i < F.bushes; i++) {
    const a = rand() * Math.PI * 2, r = 8 + Math.sqrt(rand()) * (R - 9);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (pathDist(x, z) < 1.8 || !isFree(x, z, 0)) continue;
    bush(x, z, T.leaves.length ? [C('#3d7f3a'), C('#468a40'), C('#356f33')] : T.leaves);
  }
  const caps = [C('#d9473a'), C('#c9a27a'), C('#e8c06a')];
  for (let i = 0; i < F.mushrooms; i++) {
    const a = rand() * Math.PI * 2, r = 8 + Math.sqrt(rand()) * (R - 9);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (pathDist(x, z) < 1.4 || !isFree(x, z, 0)) continue;
    mushroom(x, z, 0.8 + rand() * 0.9, pick(caps, rand()));
  }
  for (let i = 0; i < (F.crystals ?? 0); i++) {
    const a = rand() * Math.PI * 2, r = 10 + Math.sqrt(rand()) * (R - 12);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!isFree(x, z, 0)) continue;
    glowSpots.push(new THREE.Vector3(x, g(x, z) + 0.2, z));
  }

  // ── Tuna on the ground near trails (topped up to 20 per level) ──
  for (let tries = 0; tunaSpots.length < 20 && tries < 4000; tries++) {
    const s = paths[Math.floor(rand() * paths.length)];
    const t = 0.2 + rand() * 0.75;
    const off = (rand() < 0.5 ? -1 : 1) * (3 + rand() * 5);
    const dx = s[2] - s[0], dz = s[3] - s[1], l = Math.hypot(dx, dz);
    const x = s[0] + dx * t - (dz / l) * off, z = s[1] + dz * t + (dx / l) * off;
    if (!isFree(x, z, 0.8)) continue;
    tunaSpots.push(new THREE.Vector3(x, g(x, z), z));
    placed.push({ x, z, r: 0.5 });
  }

  // ── Ground perches for birds ──
  for (let i = 0, tries = 0; i < 50 && tries < 2000; tries++) {
    const a = rand() * Math.PI * 2, r = 9 + Math.sqrt(rand()) * (R - 12);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!isFree(x, z, 0.5)) continue;
    perches.push(new THREE.Vector3(x, g(x, z), z));
    i++;
  }

  // ── Finalize static meshes ──
  const staticMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  const meshes = batch.build(staticMat);
  for (const m of [...meshes.solid, ...meshes.decor]) group.add(m);

  // Lava surfaces
  const lavaMat = new THREE.MeshStandardMaterial({ color: '#ff6a1a', emissive: '#ff4a0a', emissiveIntensity: 1.6, roughness: 0.6, flatShading: true });
  for (const p of pools) {
    const geo = new THREE.CircleGeometry(p.r + 0.9, 18, 0, Math.PI * 2).rotateX(-Math.PI / 2);
    const lp = geo.attributes.position;
    for (let i = 1; i < lp.count; i++) lp.setY(i, (rand() - 0.5) * 0.12);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, lavaMat);
    m.position.set(p.x, p.lavaY, p.z);
    group.add(m);
  }

  // Glowing crystals (under isles, in caves, on obelisks...)
  if (glowSpots.length) {
    const glow = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.22, 0).scale(1, 1.8, 1),
      new THREE.MeshStandardMaterial({ color: F.glow, emissive: F.glow, emissiveIntensity: 1.6, flatShading: true }), glowSpots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3();
    glowSpots.forEach((p, i) => glow.setMatrixAt(i, m4.compose(p, q.setFromEuler(e.set(0, rand() * 3, (rand() - 0.5) * 0.4)), sv.setScalar(0.8 + rand() * 0.8))));
    group.add(glow);
  }

  // Grass tufts + flowers (instanced)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sv = new THREE.Vector3(), v = new THREE.Vector3();
  const scatter = (geo, count, y, colorFn) => {
    if (!count) return;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }), count);
    for (let i = 0, tries = 0; i < count && tries < count * 5; tries++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * (R + 4);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (pathDist(x, z) < 1.4 || Math.hypot(x, z) < 6.5 || pools.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + 1.5)) continue;
      q.setFromEuler(e.set((rand() - 0.5) * 0.5, rand() * 3, (rand() - 0.5) * 0.5));
      sv.setScalar(0.7 + rand() * 0.9);
      mesh.setMatrixAt(i, m4.compose(v.set(x, g(x, z) + y, z), q, sv));
      mesh.setColorAt(i, colorFn());
      i++;
    }
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const [th, ts, tl] = level.pal.tuft;
  scatter(new THREE.ConeGeometry(0.07, 0.36, 3), Math.round(F.grass * (lite ? 0.35 : 1)), 0.14, () => new THREE.Color().setHSL(th + rand() * 0.06, ts, tl + rand() * 0.12));
  const flowerCols = ['#ff8fb1', '#ffd85c', '#ffffff', '#b99cff', '#7fc8ff'].map(C);
  scatter(new THREE.IcosahedronGeometry(0.09, 0), Math.round(F.flowers * (lite ? 0.5 : 1)), 0.12, () => flowerCols[Math.floor(rand() * flowerCols.length)]);

  // ── Collectibles ──
  const moonMat = new THREE.MeshStandardMaterial({ color: '#a8ecff', emissive: '#3fbfff', emissiveIntensity: 1.4, roughness: 0.15, flatShading: true });
  const moonGeo = new THREE.OctahedronGeometry(0.3, 0).scale(1, 1.6, 1);
  const beamGeo = new THREE.CylinderGeometry(0.08, 0.35, 70, 6, 1, true).translate(0, 35, 0);
  const moonstones = moonSpots.map(({ p, lock }) => {
    const mesh = new THREE.Mesh(moonGeo, moonMat);
    mesh.position.copy(p).y += 0.8;
    mesh.castShadow = true;
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: '#8fe3ff', transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    beam.position.copy(p);
    beam.renderOrder = 5;
    group.add(mesh, beam);
    return { mesh, beam, base: mesh.position.clone(), taken: false, t: rand() * 6, lock: lock ?? -1 };
  });

  const tunaGeo = paint(new THREE.CylinderGeometry(0.24, 0.24, 0.17, 12, 3), (p) => {
    if (p.y > 0.084) return C('#e8edf2');
    if (p.y < -0.084) return C('#aab3bd');
    return Math.abs(p.y) < 0.05 ? C('#2f6fd6') : C('#cfd6de');
  }, 0.05);
  const tunaMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.3, flatShading: true });
  const tabGeo = new THREE.TorusGeometry(0.06, 0.015, 4, 8).rotateX(Math.PI / 2).translate(0.07, 0.09, 0);
  const fishGeo = paint(new THREE.ConeGeometry(0.05, 0.14, 3).rotateZ(Math.PI / 2).translate(0, 0, 0.245), () => C('#ffcf5a'));
  const tunas = tunaSpots.map((p) => {
    const mesh = new THREE.Group();
    const can = new THREE.Mesh(tunaGeo, tunaMat);
    can.castShadow = true;
    mesh.add(can, new THREE.Mesh(tabGeo, tunaMat), new THREE.Mesh(fishGeo, tunaMat));
    mesh.position.copy(p).y += 0.55;
    group.add(mesh);
    return { mesh, base: mesh.position.clone(), taken: false, t: rand() * 6 };
  });

  return {
    level,
    group,
    circles,
    boxes,
    perches,
    moonstones,
    tunas,
    camps,
    gate,
    pools,
    solids: meshes.solid,
    bounds: R - 1,
    spawn: new THREE.Vector3(0, 0, 4),
    groundHeight: g,
  };
}
