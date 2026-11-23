import * as THREE from 'three/webgpu';
import { paint, damp, dampAngle, mulberry32 } from './util.js';

const SPECIES = [
  { name: 'Bluebird', body: '#4a8be0', belly: '#f2a65a', head: '#4a8be0', wing: '#3a6fc2', beak: '#2b2b2b' },
  { name: 'Robin', body: '#7d6b5d', belly: '#e8643a', head: '#4d423b', wing: '#6a5a4e', beak: '#f0b030' },
  { name: 'Canary', body: '#ffd84a', belly: '#ffe98f', head: '#ffd84a', wing: '#e0b02a', beak: '#f08a30' },
  { name: 'Cardinal', body: '#d9332e', belly: '#e5554f', head: '#d9332e', wing: '#b52824', beak: '#f08a30', crest: true },
  { name: 'Chickadee', body: '#9aa0a8', belly: '#f3efe6', head: '#26232a', wing: '#7e848c', beak: '#2b2b2b' },
  { name: 'Pigeon', body: '#8e94a6', belly: '#b4b8c8', head: '#6a7a8a', wing: '#7a8094', beak: '#3a3a3a' },
];
const BIRD_SCALE = 1.7;
const FRIEND_SIZE = 0.42;
export const TRUST_NEEDED = 3;
const COUNT = 16;

function buildBird(sp, mat, darkMat) {
  const P = {};
  for (const k of ['body', 'belly', 'head', 'wing', 'beak']) P[k] = new THREE.Color(sp[k]);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const mk = (geo, color, parent = body) => {
    const m = new THREE.Mesh(paint(geo, typeof color === 'function' ? color : () => color, 0.06), mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  mk(new THREE.IcosahedronGeometry(0.12, 0).scale(1, 0.9, 1.35).translate(0, 0.17, 0),
    (p) => (p.y < 0.16 && p.z > -0.06 ? P.belly : P.body));
  const head = new THREE.Group();
  head.position.set(0, 0.27, 0.1);
  body.add(head);
  mk(new THREE.IcosahedronGeometry(0.085, 0), P.head, head);
  mk(new THREE.ConeGeometry(0.028, 0.08, 4).rotateX(Math.PI / 2).translate(0, -0.01, 0.1), P.beak, head);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 5, 4), darkMat);
    eye.position.set(s * 0.055, 0.02, 0.05);
    head.add(eye);
  }
  if (sp.crest) mk(new THREE.ConeGeometry(0.035, 0.11, 4).rotateX(-0.6).translate(0, 0.08, -0.03), P.head, head);
  const wings = [-1, 1].map((s) => {
    const w = new THREE.Group();
    w.position.set(s * 0.09, 0.21, 0);
    w.userData.s = s;
    body.add(w);
    mk(new THREE.BoxGeometry(0.22, 0.02, 0.15).translate(s * 0.11, 0, -0.02), P.wing, w);
    return w;
  });
  const tail = new THREE.Group();
  tail.position.set(0, 0.18, -0.15);
  tail.rotation.x = -0.35;
  body.add(tail);
  mk(new THREE.BoxGeometry(0.1, 0.015, 0.15).translate(0, 0, -0.07), P.wing, tail);
  for (const s of [-1, 1]) mk(new THREE.CylinderGeometry(0.008, 0.008, 0.09, 3).translate(s * 0.035, 0.045, 0.01), P.beak);
  root.scale.setScalar(BIRD_SCALE);
  return { root, body, head, wings };
}

/**
 * Songbirds that hop around, peck, and fly between perches.
 * Approach calmly and meow near one to build trust; at full trust it becomes
 * a friend that follows you (and gives you a heart).
 * Sprinting or swiping nearby startles un-befriended birds.
 */
export class Birds {
  /**
   * @param {string[]} speciesNames  which birds live in this level
   * @param {string[]} friendNames   friends carried over from earlier levels
   */
  constructor(scene, world, speciesNames, friendNames = []) {
    this.world = world;
    this.scene = scene;
    this.rand = mulberry32(77);
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });
    this.darkMat = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.3 });
    this.list = [];
    const perches = [...world.perches];
    for (let i = 0; i < COUNT && perches.length; i++) {
      const idx = Math.floor(this.rand() * perches.length);
      const perch = perches.splice(idx, 1)[0];
      const sp = SPECIES.find((x) => x.name === speciesNames[i % speciesNames.length]) ?? SPECIES[0];
      this.spawnBird(sp, perch);
    }
    for (const name of friendNames) {
      const b = this.spawnBird(SPECIES.find((x) => x.name === name) ?? SPECIES[0], world.spawn.clone().add(new THREE.Vector3((this.rand() - 0.5) * 3, 2, 2)));
      b.friend = true;
      b.trust = TRUST_NEEDED;
      b.state = 'follow';
      b.size = FRIEND_SIZE;
    }
  }

  spawnBird(sp, perch) {
      const model = buildBird(sp, this.mat, this.darkMat);
      this.scene.add(model.root);
      const b = {
        sp, ...model,
        pos: perch.clone(), from: new THREE.Vector3(), to: new THREE.Vector3(),
        state: 'perch', friend: false, trust: 0, yaw: this.rand() * 6,
        u: 0, dur: 1, arc: 1, hopY: 0, hopV: 0, hopT: this.rand() * 2, peckT: 0,
        leaveT: 8 + this.rand() * 14, meowCd: 0, fold: 1, t: this.rand() * 10,
        pitch: 0.85 + this.rand() * 0.4, size: 1,
      };
      this.list.push(b);
      return b;
  }

  get friends() {
    return this.list.filter((b) => b.friend);
  }

  flyTo(b, target, after) {
    b.state = 'fly';
    b.after = after;
    b.from.copy(b.pos);
    b.to.copy(target);
    b.u = 0;
    const d = b.from.distanceTo(b.to);
    b.dur = 0.5 + d / 7;
    b.arc = 0.8 + d * 0.18;
    b.hopY = 0;
  }

  randomPerch(b, minD, maxD) {
    const options = this.world.perches.filter((p) => {
      const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
      return d > minD && d < maxD;
    });
    return options.length ? options[Math.floor(this.rand() * options.length)] : null;
  }

  /** Nearest perched, not-yet-friendly bird within range. */
  nearestShy(pos, range = 4.5) {
    let best = null, bd = range;
    for (const b of this.list) {
      if (b.friend || b.state !== 'perch') continue;
      const d = b.pos.distanceTo(pos);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  /** Player meowed. Returns the birds that became friends. */
  meow(pos, particles, sfx) {
    const befriended = [];
    for (const b of this.list) {
      const d = b.pos.distanceTo(pos);
      if (b.friend) {
        if (d < 6) {
          b.hopV = 2.2;
          particles.spawn('note', b.pos.clone().setY(b.pos.y + b.hopY + 0.6), { vel: new THREE.Vector3(0, 0.8, 0), size: 0.28, life: 0.9 });
        }
        continue;
      }
      if (b.state !== 'perch' || d > 4.5 || b.meowCd > 0) continue;
      b.meowCd = 0.45;
      b.trust++;
      b.yaw = Math.atan2(pos.x - b.pos.x, pos.z - b.pos.z);
      b.hopV = 2.4;
      b.leaveT = Math.max(b.leaveT, 10);
      sfx.chirp(b.pitch);
      const head = b.pos.clone().setY(b.pos.y + 0.7);
      if (b.trust >= TRUST_NEEDED) {
        b.friend = true;
        b.state = 'follow';
        particles.burst('heart', head, 7, { size: 0.32, speed: 1.6, up: 2.2, life: 1.3 });
        befriended.push(b);
      } else {
        particles.spawn('heart', head, { vel: new THREE.Vector3(0, 1, 0), size: 0.22 + b.trust * 0.06, life: 1 });
      }
    }
    return befriended;
  }

  /** Something loud happened near pos — shy birds flee. */
  startle(pos, radius) {
    for (const b of this.list) {
      if (b.friend || b.state !== 'perch') continue;
      if (b.pos.distanceTo(pos) > radius) continue;
      const p = this.randomPerch(b, 15, 45);
      if (p) {
        b.trust = Math.max(0, b.trust - 1);
        this.flyTo(b, p, 'perch');
      }
    }
  }

  update(dt, player, idleTime, particles) {
    const friends = this.friends;
    const n = friends.length;
    const g = this.world.groundHeight;
    const p = player.pos;

    for (const b of this.list) {
      b.t += dt;
      b.meowCd -= dt;
      let flap = 0;
      let flying = false;

      if (b.state === 'fly') {
        flying = true;
        b.u += dt / b.dur;
        const u = Math.min(1, b.u);
        const e = u * u * (3 - 2 * u);
        b.pos.lerpVectors(b.from, b.to, e);
        b.pos.y += Math.sin(Math.PI * u) * b.arc;
        if (b.to.x !== b.from.x || b.to.z !== b.from.z) b.yaw = dampAngle(b.yaw, Math.atan2(b.to.x - b.from.x, b.to.z - b.from.z), 8, dt);
        flap = 1;
        if (u >= 1) {
          b.state = b.after;
          b.leaveT = 8 + this.rand() * 14;
        }
      } else if (b.state === 'follow') {
        flying = true;
        const k = friends.indexOf(b);
        const a = player.facing + Math.PI + (k - (n - 1) / 2) * 0.75;
        const tx = p.x + Math.sin(a) * 1.1, tz = p.z + Math.cos(a) * 1.1;
        const ty = p.y + 1.25 + Math.sin(b.t * 2 + k) * 0.15;
        const ox = b.pos.x, oz = b.pos.z;
        b.pos.x = damp(b.pos.x, tx, 3.5, dt);
        b.pos.z = damp(b.pos.z, tz, 3.5, dt);
        b.pos.y = damp(b.pos.y, ty, 3, dt);
        const mv = Math.hypot(b.pos.x - ox, b.pos.z - oz);
        b.yaw = dampAngle(b.yaw, mv > 0.01 ? Math.atan2(b.pos.x - ox, b.pos.z - oz) : player.facing, 6, dt);
        flap = 0.7;
        if (idleTime > 2.5 && player.grounded && !player.climb) {
          const la = player.facing + Math.PI * 0.5 + k * ((Math.PI * 2) / Math.max(n, 1));
          const land = new THREE.Vector3(p.x + Math.sin(la) * 0.9, p.y, p.z + Math.cos(la) * 0.9);
          if (Math.abs(g(land.x, land.z) - p.y) < 0.5) land.y = g(land.x, land.z);
          this.flyTo(b, land, 'rest');
        }
      } else {
        // perched ('perch') or resting near the player ('rest')
        b.hopT -= dt;
        if (b.hopT <= 0) {
          b.hopT = 0.6 + this.rand() * 1.8;
          if (this.rand() < 0.55) {
            b.hopV = 1.8;
            b.yaw += (this.rand() - 0.5) * 1.6;
          } else b.peckT = 0.5;
        }
        if (b.state === 'rest') {
          if (this.rand() < dt * 0.5) b.yaw = Math.atan2(p.x - b.pos.x, p.z - b.pos.z);
          if (Math.hypot(p.x - b.pos.x, p.z - b.pos.z) > 2.8 || Math.abs(p.y - b.pos.y) > 1.5 || player.climb) b.state = 'follow';
        } else {
          b.leaveT -= dt;
          const d = b.pos.distanceTo(p);
          if (d < 4.5 && player.speed > (player.walk ?? player.hero.stats.speed) * 1.25) {
            this.startle(b.pos, 0.1);
          } else if (b.leaveT <= 0 && d > 8) {
            const target = this.randomPerch(b, 6, 30);
            if (target) this.flyTo(b, target, 'perch');
            else b.leaveT = 5;
          }
        }
      }

      // hop physics
      if (b.hopV !== 0 || b.hopY > 0) {
        b.hopY += b.hopV * dt;
        b.hopV -= 12 * dt;
        if (b.hopY <= 0) {
          b.hopY = 0;
          b.hopV = 0;
        }
      }

      // pose
      b.fold = damp(b.fold, flying ? 0 : 1, 10, dt);
      const fa = flying ? Math.sin(b.t * (flap > 0.8 ? 26 : 18)) * 0.9 + 0.25 : b.hopY > 0 ? Math.sin(b.t * 30) * 0.5 : 0;
      for (const w of b.wings) {
        const s = w.userData.s;
        w.rotation.y = s * b.fold * 1.2;
        w.rotation.z = s * fa * (1 - b.fold * 0.8);
      }
      if (b.peckT > 0) b.peckT -= dt;
      b.head.rotation.x = b.peckT > 0 ? Math.max(0, Math.sin((1 - b.peckT / 0.5) * Math.PI * 2)) * 0.8 : 0;
      b.head.rotation.y = flying ? 0 : Math.sin(b.t * 1.3) * 0.4;
      b.body.rotation.x = flying ? 0.15 : 0;
      b.size = damp(b.size, b.friend ? FRIEND_SIZE : 1, 3, dt);
      b.root.scale.setScalar(BIRD_SCALE * b.size);
      b.root.position.set(b.pos.x, b.pos.y + b.hopY, b.pos.z);
      b.root.rotation.y = b.yaw;
    }
  }
}
