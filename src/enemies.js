import * as THREE from 'three/webgpu';
import { paint, damp, dampAngle, clamp } from './util.js';

/**
 * Camp guards. Two archetypes, tinted per level:
 *  - blob:   hops toward you; bump damage. Stomp it or claw it.
 *  - beetle: wanders, then winds up and charges in a straight line.
 * They stay leashed to their camp. A camp is cleared when all its guards are gone.
 */
const AGGRO = 10;

function buildBlob(color) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0 });
  const base = new THREE.Color(color), dark = base.clone().multiplyScalar(0.7);
  const m = new THREE.Mesh(paint(new THREE.IcosahedronGeometry(0.5, 1).scale(1, 0.8, 1).translate(0, 0.4, 0), (p) => (p.y < 0.2 ? dark : base)), mat);
  m.castShadow = true;
  body.add(m);
  addFace(body, 0.38, 0.48, 0.42, 0.13);
  return { root, body, mats: [mat], radius: 0.5, height: 0.8 };
}

function buildBeetle(color) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.35, metalness: 0.2, emissive: '#ffffff', emissiveIntensity: 0 });
  const base = new THREE.Color(color), stripe = base.clone().offsetHSL(0, 0, 0.15), dark = new THREE.Color('#1a1418');
  const shell = new THREE.Mesh(paint(new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.9, 0.75, 1.15).translate(0, 0.22, 0),
    (p) => (Math.abs(p.x) < 0.05 ? dark : p.y > 0.55 ? stripe : base)), mat);
  shell.castShadow = true;
  body.add(shell);
  const head = new THREE.Mesh(paint(new THREE.IcosahedronGeometry(0.24, 0).translate(0, 0.3, 0.62), () => dark), mat);
  body.add(head);
  const horn = new THREE.Mesh(paint(new THREE.ConeGeometry(0.07, 0.35, 4).rotateX(1.1).translate(0, 0.5, 0.82), () => stripe), mat);
  body.add(horn);
  const legs = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(paint(new THREE.BoxGeometry(0.32, 0.05, 0.05).translate(s * 0.16, 0, 0), () => dark), mat);
      leg.position.set(s * 0.38, 0.16, -0.3 + i * 0.3);
      leg.rotation.z = -s * 0.5;
      body.add(leg);
      legs.push(leg);
    }
  }
  addFace(body, 0.3, 0.36, 0.78, 0.08, '#ff4a3a');
  return { root, body, mats: [mat], legs, radius: 0.6, height: 0.7 };
}

/** Big googly eyes with angry brows. */
function addFace(parent, y, spread, z, size, irisColor = '#1a1418') {
  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 });
  const iris = new THREE.MeshStandardMaterial({ color: irisColor, emissive: irisColor === '#1a1418' ? '#000' : irisColor, emissiveIntensity: 0.8 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), white);
    e.position.set(s * spread * 0.5, y, z);
    parent.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(size * 0.5, 6, 4), iris);
    p.position.set(s * spread * 0.5, y, z + size * 0.75);
    parent.add(p);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(size * 1.6, size * 0.35, size * 0.35), new THREE.MeshBasicMaterial({ color: '#1a1418' }));
    brow.position.set(s * spread * 0.5, y + size * 1.05, z + size * 0.4);
    brow.rotation.z = s * 0.45;
    parent.add(brow);
  }
}

export class Enemies {
  constructor(scene, world, levelIndex) {
    this.scene = scene;
    this.world = world;
    this.list = [];
    this.levelIndex = levelIndex;
    this.waves = [];
    this.waveGeo = new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);
    world.camps.forEach((camp, ci) => {
      for (const sp of camp.spawns) this.spawn(sp, ci);
    });
  }

  spawn(sp, ci) {
    const E = this.world.level.enemy;
    const isBoss = sp.type === 'boss';
    const kind = isBoss ? (sp.boss === 'gloom' ? 'blob' : 'beetle') : sp.type;
    const model = kind === 'blob' ? buildBlob(isBoss ? E.bossColor ?? E.blob : E.blob) : buildBeetle(isBoss ? E.bossColor ?? E.beetle : E.beetle);
    const y = this.world.groundHeight(sp.x, sp.z);
    model.root.position.set(sp.x, y, sp.z);
    this.scene.add(model.root);
    const e = {
      ...model, type: kind, camp: ci,
      pos: new THREE.Vector3(sp.x, y, sp.z), home: new THREE.Vector3(sp.x, y, sp.z),
      vel: new THREE.Vector3(), yaw: Math.random() * 6, hp: (kind === 'blob' ? 2 : 3) + E.hp - 1,
      state: 'idle', timer: Math.random() * 2, hopY: 0, hopV: 0, flash: 0, stun: 0, dead: false, t: Math.random() * 10,
      speedMul: 1 + this.levelIndex * 0.06, scale: 1,
    };
    if (isBoss) {
      const BOSS = { thornback: { name: 'Thornback', hp: 14, scale: 3 }, gloom: { name: 'The Gloom King', hp: 20, scale: 3.2 } }[sp.boss];
      Object.assign(e, { boss: sp.boss, name: BOSS.name, hp: BOSS.hp, scale: BOSS.scale, cycle: 0, hops: 0 });
      e.radius *= BOSS.scale * 0.85;
      e.height *= BOSS.scale;
      model.root.scale.setScalar(BOSS.scale);
    }
    e.maxHp = e.hp;
    this.list.push(e);
    return e;
  }

  /** The boss you're currently fighting (for the HUD health bar), or null. */
  activeBoss() {
    return this.list.find((e) => e.boss && e.engaged && e.dead !== true) ?? null;
  }

  shockwave(x, y, z, max) {
    const mesh = new THREE.Mesh(this.waveGeo, new THREE.MeshBasicMaterial({
      color: '#ffcf6a', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    mesh.position.set(x, y + 0.15, z);
    this.scene.add(mesh);
    this.waves.push({ x, y, z, r: 1, max, mesh, hit: false });
  }

  /** Boss behaviour; sets velocity/state. Returns extra minions to spawn. */
  updateBoss(e, dt, p, aggro, spawns) {
    const spd = e.speedMul;
    const dx = p.x - e.pos.x, dz = p.z - e.pos.z, dist = Math.hypot(dx, dz) || 1;
    if (aggro) e.engaged = true;
    if (!e.engaged) {
      e.vel.multiplyScalar(Math.exp(-6 * dt));
      return;
    }
    const face = (k = 6) => {
      e.yaw = dampAngle(e.yaw, Math.atan2(dx, dz), k, dt);
    };
    if (e.boss === 'thornback') {
      if (e.state === 'idle') {
        e.state = 'windup';
        e.timer = 0.9;
      } else if (e.state === 'windup') {
        e.vel.set(0, 0, 0);
        face(8);
        if (e.timer <= 0) {
          e.cycle++;
          if (e.cycle % 3 === 0) {
            // leap at you; the landing sends out a shockwave you need to jump over
            e.state = 'leap';
            e.hopV = 11;
            const sp = Math.min(dist, 10) / 1.1;
            e.vel.set((dx / dist) * sp, 0, (dz / dist) * sp);
          } else {
            e.state = 'charge';
            e.timer = 1.2;
            e.vel.set(Math.sin(e.yaw) * 12 * spd, 0, Math.cos(e.yaw) * 12 * spd);
          }
        }
      } else if (e.state === 'charge') {
        if (e.timer <= 0) {
          e.state = 'rest';
          e.timer = 0.8;
        }
      } else if (e.state === 'leap') {
        if (e.justLanded) {
          this.shockwave(e.pos.x, e.pos.y, e.pos.z, 13);
          e.state = 'dazed';
          e.timer = 2.2;
          e.vel.set(0, 0, 0);
        }
      } else if (e.state === 'rest') {
        e.vel.multiplyScalar(Math.exp(-6 * dt));
        if (e.timer <= 0) {
          e.state = 'windup';
          e.timer = 0.7;
        }
      } else if (e.state === 'dazed') {
        e.vel.multiplyScalar(Math.exp(-8 * dt));
        if (e.timer <= 0) {
          e.state = 'windup';
          e.timer = 0.9;
        }
      }
      if (!e.split1 && e.hp <= e.maxHp / 2) {
        e.split1 = true;
        spawns.push('blob', 'blob');
      }
    } else {
      // The Gloom King: big hops, shockwave on every landing, splits as it weakens
      if (e.state === 'idle') {
        e.state = 'hop';
        e.timer = 0.4;
      } else if (e.state === 'hop') {
        if (e.justLanded) {
          this.shockwave(e.pos.x, e.pos.y, e.pos.z, 9);
          e.vel.set(0, 0, 0);
          if (e.hops % 4 === 0) {
            e.state = 'dazed';
            e.timer = 2.0;
          }
        }
        if (e.hopY <= 0 && e.hopV <= 0 && e.timer <= 0) {
          e.hops++;
          e.hopV = 10;
          face(20);
          const sp = Math.min(dist, 8);
          e.vel.set((dx / dist) * sp * spd, 0, (dz / dist) * sp * spd);
          e.timer = 1.4 / spd;
        }
      } else if (e.state === 'dazed') {
        if (e.timer <= 0) {
          e.state = 'hop';
          e.timer = 0.3;
        }
      }
      for (const [k, frac] of [['split1', 2 / 3], ['split2', 1 / 3]]) {
        if (!e[k] && e.hp <= e.maxHp * frac) {
          e[k] = true;
          spawns.push('blob', 'blob');
        }
      }
    }
  }

  alive(campIndex) {
    return this.list.filter((e) => !e.dead && e.camp === campIndex).length;
  }

  /** Hit every enemy within `radius` of (x, z) at roughly height y. Returns enemies hit. */
  hitAt(x, z, y, radius, dmg, kx, kz) {
    const hits = [];
    for (const e of this.list) {
      if (e.dead) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d > radius + e.radius || Math.abs(e.pos.y + e.hopY - y) > 1.4 + (e.boss ? 1.5 : 0)) continue;
      this.damage(e, dmg, kx, kz);
      hits.push(e);
    }
    return hits;
  }

  /** Nearest living enemy within range of pos, or null. */
  nearest(pos, range) {
    let best = null, bd = range;
    for (const e of this.list) {
      if (e.dead) continue;
      const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
      if (d < bd && Math.abs(e.pos.y - pos.y) < 3) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  damage(e, n, kx, kz) {
    if (e.boss) {
      // bosses barely budge, but take double damage while dazed
      e.hp -= e.state === 'dazed' ? n * 2 : n;
      e.flash = 0.18;
      e.vel.x += kx * 1.5;
      e.vel.z += kz * 1.5;
      e.engaged = true;
      if (e.hp <= 0) e.dead = 'dying';
      return;
    }
    e.hp -= n;
    e.flash = 0.18;
    e.stun = 0.45;
    e.vel.set(kx * 7, 0, kz * 7);
    e.hopV = 3.5;
    if (e.state === 'charge' || e.state === 'windup') e.state = 'rest';
    e.timer = 0.6;
    if (e.hp <= 0) e.dead = 'dying';
  }

  /**
   * @returns {{hurt: THREE.Vector3|null, killed: Array, stomped: boolean}}
   */
  update(dt, player) {
    const out = { hurt: null, killed: [], stomped: false };
    const g = this.world.groundHeight;
    const p = player.pos;
    for (const e of this.list) {
      if (e.dead === true) continue;
      e.t += dt;
      if (e.dead === 'dying') {
        e.root.scale.multiplyScalar(Math.exp(-14 * dt));
        e.root.position.y += dt * 2;
        if (e.root.scale.x < 0.05) {
          e.dead = true;
          e.root.visible = false;
          out.killed.push(e);
        }
        continue;
      }
      const camp = this.world.camps[e.camp];
      const toP = Math.hypot(p.x - e.pos.x, p.z - e.pos.z);
      const playerInCamp = Math.hypot(p.x - camp.x, p.z - camp.z) < camp.r + 4 && Math.abs(p.y - camp.y) < 3;
      const aggro = playerInCamp && toP < AGGRO && !player.climb;
      const spd = e.speedMul;

      e.timer -= dt;
      e.stun -= dt;
      e.flash -= dt;
      let moving = false;

      if (e.boss) {
        this.updateBoss(e, dt, p, playerInCamp && !player.climb, this.pendingSpawns ??= []);
        if (this.pendingSpawns.length) {
          for (const type of this.pendingSpawns.splice(0)) {
            const a = Math.random() * Math.PI * 2;
            const m = this.spawn({ type, x: e.pos.x + Math.cos(a) * 3, z: e.pos.z + Math.sin(a) * 3 }, e.camp);
            m.hopV = 6;
            m.state = 'idle';
          }
        }
        moving = e.state === 'charge';
      } else if (e.stun > 0) {
        // knocked back
      } else if (e.type === 'blob') {
        if (e.hopY <= 0 && e.timer <= 0) {
          let tx, tz;
          if (aggro) {
            tx = p.x - e.pos.x;
            tz = p.z - e.pos.z;
            e.timer = 0.55 / spd;
          } else {
            const a = Math.random() * Math.PI * 2;
            tx = e.home.x + Math.cos(a) * 2 - e.pos.x;
            tz = e.home.z + Math.sin(a) * 2 - e.pos.z;
            e.timer = 1 + Math.random() * 1.5;
          }
          const l = Math.hypot(tx, tz) || 1;
          const sp = aggro ? 3.6 * spd : 1.4;
          e.vel.set((tx / l) * sp, 0, (tz / l) * sp);
          e.hopV = aggro ? 5.5 : 3.5;
          e.yaw = Math.atan2(tx, tz);
        }
        if (e.hopY <= 0 && e.hopV <= 0) e.vel.multiplyScalar(Math.exp(-12 * dt));
      } else {
        // beetle
        if (e.state === 'idle') {
          if (aggro) {
            e.yaw = dampAngle(e.yaw, Math.atan2(p.x - e.pos.x, p.z - e.pos.z), 6, dt);
            const s = 1.6 * spd;
            e.vel.set(Math.sin(e.yaw) * s, 0, Math.cos(e.yaw) * s);
            moving = true;
            if (toP < 7 && e.timer <= 0) {
              e.state = 'windup';
              e.timer = 0.7;
            }
          } else {
            const hx = e.home.x - e.pos.x, hz = e.home.z - e.pos.z;
            if (Math.hypot(hx, hz) > 1.5) {
              e.yaw = dampAngle(e.yaw, Math.atan2(hx, hz), 4, dt);
              e.vel.set(Math.sin(e.yaw) * 1.2, 0, Math.cos(e.yaw) * 1.2);
              moving = true;
            } else e.vel.multiplyScalar(Math.exp(-8 * dt));
          }
        } else if (e.state === 'windup') {
          e.vel.set(0, 0, 0);
          e.yaw = dampAngle(e.yaw, Math.atan2(p.x - e.pos.x, p.z - e.pos.z), 10, dt);
          if (e.timer <= 0) {
            e.state = 'charge';
            e.timer = 0.85;
            const s = 9 * spd;
            e.vel.set(Math.sin(e.yaw) * s, 0, Math.cos(e.yaw) * s);
          }
        } else if (e.state === 'charge') {
          moving = true;
          if (e.timer <= 0) {
            e.state = 'rest';
            e.timer = 1.1;
          }
        } else if (e.state === 'rest') {
          e.vel.multiplyScalar(Math.exp(-6 * dt));
          if (e.timer <= 0) {
            e.state = 'idle';
            e.timer = 0.8;
          }
        }
      }

      // integrate, stay inside the camp
      e.pos.x += e.vel.x * dt;
      e.pos.z += e.vel.z * dt;
      const ox = e.pos.x - camp.x, oz = e.pos.z - camp.z, od = Math.hypot(ox, oz);
      const lim = camp.r - e.radius;
      if (od > lim) {
        e.pos.x = camp.x + (ox / od) * lim;
        e.pos.z = camp.z + (oz / od) * lim;
        if (e.state === 'charge') {
          e.state = 'rest';
          e.timer = 1.1;
        }
      }
      // don't stand inside the cage pedestal
      const cd = Math.hypot(e.pos.x - camp.cx, e.pos.z - camp.cz);
      if (cd < 1.4 + e.radius) {
        const k = (1.4 + e.radius) / (cd || 1);
        e.pos.x = camp.cx + (e.pos.x - camp.cx) * k;
        e.pos.z = camp.cz + (e.pos.z - camp.cz) * k;
      }
      e.pos.y = g(e.pos.x, e.pos.z);
      e.justLanded = false;
      if (e.hopV !== 0 || e.hopY > 0) {
        e.hopY += e.hopV * dt;
        e.hopV -= 20 * dt;
        if (e.hopY <= 0) {
          e.justLanded = e.hopV < -1;
          e.hopY = 0;
          e.hopV = 0;
        }
      }

      // contact with the player
      const dy = p.y - (e.pos.y + e.hopY);
      const dist = Math.hypot(p.x - e.pos.x, p.z - e.pos.z);
      if (dist < e.radius + player.radius + 0.1 && dy > -1 && dy < e.height + 0.2) {
        if (player.vel.y < -1 && dy > e.height * 0.45) {
          // stomp!
          this.damage(e, e.boss ? 1 : 2, 0, 0);
          player.vel.y = e.boss ? 11 : 9;
          out.stomped = true;
        } else if (!out.hurt) {
          out.hurt = e.pos.clone();
        }
      }

      // pose
      e.root.position.set(e.pos.x, e.pos.y + e.hopY, e.pos.z);
      e.root.rotation.y = e.yaw;
      if (e.type === 'blob') {
        const sq = e.hopY > 0 ? 1 + Math.min(0.25, e.hopV * 0.04) : 1 + Math.sin(e.t * 6) * 0.04;
        e.body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
      } else {
        const wob = e.state === 'windup' ? Math.sin(e.t * 50) * 0.06 : 0;
        e.body.rotation.z = wob;
        e.body.position.y = e.state === 'windup' ? 0.05 : 0;
        e.legs.forEach((l, i) => { l.rotation.y = moving ? Math.sin(e.t * 22 + i * 1.7) * 0.5 : 0; });
      }
      if (e.boss && e.state === 'dazed') e.body.rotation.z = Math.sin(e.t * 6) * 0.15;
      const fl = e.flash > 0 ? 1.2 : e.state === 'windup' ? 0.35 + Math.sin(e.t * 30) * 0.3 : 0;
      for (const m of e.mats) {
        m.emissiveIntensity = fl;
        m.emissive.set(e.state === 'windup' && e.flash <= 0 ? '#ff2a1a' : '#ffffff');
      }
    }
    // expanding shockwave rings: jump over them!
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.r += 10 * dt;
      w.mesh.scale.set(w.r, 1, w.r);
      w.mesh.material.opacity = 0.9 * (1 - w.r / w.max);
      const d = Math.hypot(p.x - w.x, p.z - w.z);
      const onGround = p.y - g(p.x, p.z) < 0.45 && player.grounded;
      if (!w.hit && onGround && Math.abs(d - w.r) < 0.6 && Math.abs(p.y - w.y) < 1.5) {
        w.hit = true;
        out.hurt = new THREE.Vector3(w.x, w.y, w.z);
      }
      if (w.r >= w.max) {
        this.scene.remove(w.mesh);
        w.mesh.material.dispose();
        this.waves.splice(i, 1);
      }
    }
    return out;
  }
}
