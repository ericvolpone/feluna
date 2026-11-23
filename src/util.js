import * as THREE from 'three/webgpu';

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function dampAngle(a, b, k, dt) {
  const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + diff * (1 - Math.exp(-k * dt));
}

export function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function hash2(x, z) {
  return hash(x * 12.9898 + z * 78.233);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Converts a geometry to flat, per-face vertex colors — the core of the low-poly look.
 * colorAt(centroid) returns a THREE.Color for each triangle; a small brightness jitter
 * per face keeps large surfaces from looking plastic.
 */
const _p = new THREE.Vector3();
export function paint(geo, colorAt, jitter = 0.12) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    _p.set(
      (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3,
      (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3,
      (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3,
    );
    const c = colorAt(_p);
    const j = 1 - jitter / 2 + hash(i * 0.37 + _p.x * 13.1 + _p.y * 5.3 + _p.z * 7.7) * jitter;
    for (let k = 0; k < 3; k++) {
      col[(i + k) * 3] = c.r * j;
      col[(i + k) * 3 + 1] = c.g * j;
      col[(i + k) * 3 + 2] = c.b * j;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}
