import * as THREE from 'three/webgpu';
import { makeSky } from './sky.js';
import { buildWorld } from './world.js';
import { LEVELS } from './levels.js';
import { Player } from './player.js';
import { Birds, TRUST_NEEDED } from './birds.js';
import { Enemies } from './enemies.js';
import { Particles } from './particles.js';
import { Hud } from './hud.js';
import { sfx, playMusic } from './audio.js';
import { clamp, damp, disposeTree } from './util.js';

const MOUSE_SENS = 0.0024;
const STICK_YAW = 2.8;
const STICK_PITCH = 1.9;
const TUNA_PER_POWERUP = 10;

const PERKS = [
  { friends: 1, name: 'Flutter', toast: 'Flutter unlocked! Jump again in mid-air' },
  { friends: 3, name: 'Glide', toast: 'Glide unlocked! Hold jump while falling' },
  { friends: 5, name: 'Double Flutter', toast: 'Double Flutter! Two mid-air jumps' },
];

export const POWERUPS = [
  { id: 'speed', icon: '🐾', name: 'Swift Paws', desc: '+12% run & climb speed' },
  { id: 'jump', icon: '🌙', name: 'Spring Legs', desc: '+12% jump height' },
  { id: 'heart', icon: '❤️', name: 'Extra Heart', desc: '+1 max heart, fully healed' },
];

/** A run carries hearts, powerups and bird friends from level to level. */
export function newRun(hero) {
  return { hero, level: 0, hearts: 3, maxHearts: 3, speedLv: 0, jumpLv: 0, tuna: 0, tunaTotal: 0, moonTotal: 0, friends: [], start: performance.now() };
}

export class GameScene {
  constructor(input, run, canvas, { onQuit, onNext, onRetry }) {
    this.input = input;
    this.run = run;
    this.hero = run.hero;
    this.level = LEVELS[run.level];
    this.canvas = canvas;
    this.cb = { onQuit, onNext, onRetry };
    const L = this.level;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 260);
    this.scene.fog = new THREE.Fog(...L.fog);
    this.sky = makeSky({ ...L.sky, radius: 200 });
    this.scene.add(this.sky);
    this.scene.add(new THREE.HemisphereLight(L.light.sky, L.light.ground, L.light.hemi));
    this.sun = new THREE.DirectionalLight(L.light.sun, L.light.sunI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 100 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.world = buildWorld(L, run.level + 1);
    this.scene.add(this.world.group);
    this.player = new Player(this.hero, this.world);
    this.scene.add(this.player.cat.root);
    this.birds = new Birds(this.scene, this.world, L.birds, run.friends);
    this.enemies = new Enemies(this.scene, this.world, run.level);
    this.particles = new Particles(this.scene);
    this.pickups = [];

    this.moonFound = 0;
    this.idleTime = 0;
    this.meowCd = 0;
    this.choices = [];
    this.choice = null;
    this.ended = null;
    this.leaving = false;

    // Camera rig
    this.yaw = 0;
    this.pitch = 0.3;
    this.dist = 5.4;
    this.camDist = this.dist;
    this.focus = this.player.pos.clone().add(new THREE.Vector3(0, 0.9, 0));
    this.ray = new THREE.Raycaster();
    this._dir = new THREE.Vector3();
    this._v = new THREE.Vector3();

    this.hud = new Hud();
    this.hud.show(this.hero, `${run.level + 1}. ${L.name}`);
    this.refreshHud();
    this.hud.setDevice(input.device);
    this.prevDeviceCb = input.onDeviceChange;
    input.onDeviceChange = (d) => {
      this.hud.setDevice(d);
      this.contextKey = null;
    };
    this.hud.banner(`Level ${run.level + 1}`, L.name);
    playMusic(L.music);

    this.paused = false;
    this.pauseSel = 0;
    this.lastPauseToggle = 0;
    this.onClick = () => {
      if (!this.paused && !this.choice && !this.ended) canvas.requestPointerLock?.()?.catch?.(() => {});
    };
    this.onLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      // Browser consumes Esc to release pointer lock — treat that as "pause".
      if (!locked && this.wasLocked && !this.paused && !this.choice && !this.ended) this.setPaused(true);
      this.wasLocked = locked;
    };
    this.onOverlayClick = (e) => {
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      const i = +btn.dataset.i;
      if (btn.closest('#pause')) this.choosePause(i);
      else if (btn.closest('#choice')) this.applyChoice(i);
      else if (btn.closest('#end')) this.chooseEnd(i);
    };
    canvas.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('click', this.onOverlayClick);
  }

  get friendCount() {
    return this.birds.friends.length;
  }

  get mods() {
    const sp = 1 + 0.12 * this.run.speedLv;
    const f = this.friendCount;
    return {
      speedMul: sp,
      jumpMul: Math.sqrt(1 + 0.12 * this.run.jumpLv),
      climbMul: sp,
      airJumps: f >= 5 ? 2 : f >= 1 ? 1 : 0,
      glide: f >= 3,
    };
  }

  refreshHud() {
    const r = this.run;
    this.hud.setHearts(r.hearts, r.maxHearts);
    this.hud.setStats({
      moon: this.moonFound, moonTotal: this.world.moonstones.length,
      tuna: r.tuna, tunaNeed: TUNA_PER_POWERUP,
      friends: this.friendCount,
      perks: PERKS.filter((p) => this.friendCount >= p.friends).map((p) => p.name),
      levels: [r.speedLv, r.jumpLv],
    });
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setPaused(on) {
    const now = performance.now();
    if (now - this.lastPauseToggle < 250) return;
    this.lastPauseToggle = now;
    this.paused = on;
    this.pauseSel = 0;
    this.hud.showPause(on, 0);
    if (on && document.pointerLockElement) document.exitPointerLock();
    if (!on && this.input.device === 'keyboard') this.canvas.requestPointerLock?.()?.catch?.(() => {});
  }

  choosePause(i) {
    if (i === 0) this.setPaused(false);
    else this.cb.onQuit();
  }

  // ── Powerup choices ──
  queueChoice(reason) {
    this.choices.push(reason);
    if (!this.choice) this.openChoice();
  }

  openChoice() {
    const reason = this.choices.shift();
    if (!reason) return;
    this.choice = { reason, sel: 0 };
    if (document.pointerLockElement) document.exitPointerLock();
    sfx.powerup();
    this.hud.showChoice(reason, POWERUPS, this.run, 0);
  }

  applyChoice(i) {
    if (!this.choice) return;
    const id = POWERUPS[i].id;
    const r = this.run;
    if (id === 'speed') r.speedLv++;
    else if (id === 'jump') r.jumpLv++;
    else {
      r.maxHearts++;
      r.hearts = r.maxHearts;
    }
    sfx.heal();
    this.particles.burst('sparkle', this._v.copy(this.player.pos).setY(this.player.pos.y + 0.8), 12, { size: 0.4, speed: 2.5, up: 3, life: 1, additive: true });
    this.hud.toast(`${POWERUPS[i].icon} ${POWERUPS[i].name}!`);
    this.choice = null;
    this.hud.showChoice(null);
    this.refreshHud();
    if (this.choices.length) this.openChoice();
    else if (this.input.device === 'keyboard') this.canvas.requestPointerLock?.()?.catch?.(() => {});
  }

  // ── Damage / end states ──
  hurt(from, knock = true) {
    const p = this.player;
    if (p.invuln > 0 || this.ended) return;
    this.run.hearts = Math.max(0, this.run.hearts - 1);
    p.invuln = 1.4;
    if (knock) p.knock(from);
    sfx.hurt();
    this.particles.burst('puff', this._v.copy(p.pos).setY(p.pos.y + 0.5), 5, { size: 0.5, speed: 2, up: 1, life: 0.4 });
    this.refreshHud();
    if (this.run.hearts <= 0) this.endRun('gameover');
  }

  endRun(kind) {
    this.ended = { kind, sel: 0 };
    if (document.pointerLockElement) document.exitPointerLock();
    const r = this.run;
    const mins = Math.floor((performance.now() - r.start) / 60000);
    const secs = Math.floor(((performance.now() - r.start) / 1000) % 60);
    this.hud.showEnd(kind, {
      level: kind === 'victory' ? LEVELS.length : r.level + 1,
      levelName: this.level.name,
      moon: r.moonTotal + this.moonFound,
      tuna: r.tunaTotal,
      friends: this.friendCount,
      time: `${mins}:${String(secs).padStart(2, '0')}`,
    }, 0);
    if (kind === 'victory') sfx.gateOpen();
  }

  chooseEnd(i) {
    if (!this.ended) return;
    if (i === 0) this.cb.onRetry();
    else this.cb.onQuit();
  }

  // ── Main update ──
  update(dt, locked) {
    const s = this.input.state;
    if (locked) return this.render(dt, true);

    if (this.ended) {
      if (s.left || s.right || s.up || s.down) {
        this.ended.sel ^= 1;
        this.hud.selectEnd(this.ended.sel);
        sfx.select();
      }
      if (s.confirm) this.chooseEnd(this.ended.sel);
      return this.render(dt, true);
    }
    if (this.choice) {
      if (s.left || s.up) this.choice.sel = (this.choice.sel + POWERUPS.length - 1) % POWERUPS.length;
      if (s.right || s.down) this.choice.sel = (this.choice.sel + 1) % POWERUPS.length;
      if (s.left || s.right || s.up || s.down) {
        this.hud.showChoice(this.choice.reason, POWERUPS, this.run, this.choice.sel);
        sfx.select();
      }
      if (s.confirm) this.applyChoice(this.choice.sel);
      return this.render(dt, true);
    }
    if (this.paused) {
      if (s.up || s.down) {
        this.pauseSel = (this.pauseSel + 1) % 2;
        this.hud.showPause(true, this.pauseSel);
      }
      if (s.confirm) this.choosePause(this.pauseSel);
      else if (s.back || s.pause) this.setPaused(false);
      return this.render(dt, true);
    }
    if (s.pause) {
      this.setPaused(true);
      return this.render(dt, true);
    }

    // Look
    this.yaw -= s.mouse.x * MOUSE_SENS + s.look.x * STICK_YAW * dt;
    this.pitch = clamp(this.pitch + s.mouse.y * MOUSE_SENS + s.look.y * STICK_PITCH * dt, -0.35, 1.2);

    const p = this.player;
    p.update(dt, s, this.yaw, this.mods);
    this.handleEvents();

    // Meow
    this.meowCd -= dt;
    if (s.meowPressed && this.meowCd <= 0) {
      this.meowCd = 0.4;
      p.cat.meow();
      sfx.meow(this.hero.id === 'felix' ? 0.85 : 1.12);
      this.particles.spawn('note', this._v.copy(p.pos).setY(p.pos.y + 1.3), { vel: new THREE.Vector3(0.4, 1.1, 0), size: 0.32, life: 1 });
      for (const b of this.birds.meow(p.pos, this.particles, sfx)) this.befriend(b);
    }

    // Lava burns while you stand in it
    if (p.inLava && p.invuln <= 0) {
      sfx.sizzle();
      this.particles.burst('puff', p.pos, 6, { size: 0.5, speed: 1.5, up: 2, life: 0.6 });
      this.hurt(p.pos, false);
      // hop up and toward the nearest shore so you're never trapped
      const pl = p.inLava, dx = p.pos.x - pl.x, dz = p.pos.z - pl.z, d = Math.hypot(dx, dz) || 1;
      p.vel.set((dx / d) * 6, 9.5, (dz / d) * 6);
      p.grounded = false;
    }

    // Enemies
    const res = this.enemies.update(dt, p);
    if (res.hurt) this.hurt(res.hurt);
    if (res.stomped) {
      sfx.hit();
      this.particles.burst('puff', p.pos, 5, { size: 0.5, speed: 2, up: 0.5, life: 0.4 });
    }
    for (const e of res.killed) this.onKilled(e);
    this.world.camps.forEach((camp, ci) => {
      if (!camp.cleared && this.enemies.alive(ci) === 0) this.clearCamp(ci);
    });

    this.idleTime = p.grounded && !p.climb && p.speed < 0.3 ? this.idleTime + dt : 0;
    this.birds.update(dt, p, this.idleTime, this.particles);
    this.updateCollectibles(dt);
    this.updateGate(dt);
    this.updateContext();
    this.render(dt, false);
  }

  surface() {
    const p = this.player.pos;
    return p.y - this.world.groundHeight(p.x, p.z) > 0.25 ? (this.level.id === 'forest' ? 'wood' : 'stone') : this.level.surface;
  }

  handleEvents() {
    const p = this.player;
    for (const e of p.events) {
      if (e === 'swipe') {
        sfx.swipe();
        const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
        const at = this._v.set(p.pos.x + fx * 0.7, p.pos.y + 0.6 * this.hero.scale, p.pos.z + fz * 0.7);
        this.particles.spawn('slash', at, { vel: new THREE.Vector3(fx, 0, fz), size: 0.9, life: 0.22 });
        this.birds.startle(p.pos, 3.5);
        const hits = this.enemies.swipe(p);
        if (hits.length) {
          sfx.hit();
          for (const h of hits) this.particles.burst('sparkle', h.root.position.clone().setY(h.root.position.y + 0.5), 4, { size: 0.3, speed: 2, up: 1.5, life: 0.35, additive: true });
        }
      } else if (e === 'latch') {
        sfx.latch();
      } else if (e === 'jump' || e === 'mount') {
        sfx.jump();
      } else if (e === 'flutter') {
        sfx.flutter();
        this.particles.burst('feather', this._v.copy(p.pos).setY(p.pos.y + 0.4), 5, { size: 0.22, speed: 1.4, up: -0.5, life: 0.8, gravity: 1, spin: 3 });
      } else if (e === 'land') {
        sfx.land();
        this.particles.burst('puff', p.pos, 6, { size: 0.6, speed: 2, up: 0.4, life: 0.5, grow: 1 });
        this.birds.startle(p.pos, 4);
      } else if (e === 'softland') {
        sfx.land(true);
      } else if (e === 'step') {
        sfx.step(this.surface());
      } else if (e === 'climbstep') {
        sfx.step('wood');
      }
    }
  }

  befriend(b) {
    this.run.friends.push(b.sp.name);
    sfx.birdSong(b.pitch);
    const perk = PERKS.find((x) => x.friends === this.friendCount);
    this.hud.toast(perk ? `♥ ${b.sp.name} is your friend! ${perk.toast}` : `♥ ${b.sp.name} is your friend!`);
    this.refreshHud();
  }

  onKilled(e) {
    sfx.defeat();
    this.particles.burst('sparkle', e.pos.clone().setY(e.pos.y + 0.5), 10, { size: 0.4, speed: 2.5, up: 2.5, life: 0.8, additive: true });
    this.particles.burst('puff', e.pos, 6, { size: 0.7, speed: 1.5, up: 0.8, life: 0.6, grow: 1 });
    if (Math.random() < 0.45) this.dropHeart(e.pos);
  }

  dropHeart(pos) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshBasicMaterial({
      map: this.particles.textures.heart, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.position.copy(pos).y += 0.6;
    this.scene.add(mesh);
    this.pickups.push({ mesh, base: mesh.position.clone(), t: 0 });
  }

  clearCamp(ci) {
    const camp = this.world.camps[ci];
    camp.cleared = true;
    camp.cage.col.off = true;
    camp.cageT = 0;
    const m = this.world.moonstones[camp.moon];
    m.beam.material.color.set('#8fe3ff');
    this.hud.toast('Guards defeated! The cage opens');
    this.queueChoice('Guards defeated!');
  }

  updateCollectibles(dt) {
    const p = this.player.pos;
    const cy = p.y + 0.5;
    const r = this.run;
    for (const c of this.world.tunas) {
      c.t += dt;
      if (c.taken) {
        c.mesh.scale.multiplyScalar(Math.exp(-12 * dt));
        c.mesh.visible = c.mesh.scale.x > 0.02;
        continue;
      }
      c.mesh.rotation.set(0.35, c.t * 1.8, 0);
      c.mesh.position.y = c.base.y + Math.sin(c.t * 2.5) * 0.1;
      if (Math.hypot(c.base.x - p.x, c.base.z - p.z) < 0.85 && Math.abs(c.base.y - cy) < 1) {
        c.taken = true;
        r.tuna++;
        r.tunaTotal++;
        sfx.tuna();
        this.particles.burst('sparkle', c.mesh.position, 8, { size: 0.35, speed: 2, up: 2.5, life: 0.7, additive: true });
        if (r.tuna >= TUNA_PER_POWERUP) {
          r.tuna -= TUNA_PER_POWERUP;
          this.queueChoice(`${TUNA_PER_POWERUP} tuna cans!`);
        } else this.hud.toast(`Tuna! ${r.tuna} / ${TUNA_PER_POWERUP} to a powerup`);
        this.refreshHud();
      }
    }
    for (const camp of this.world.camps) {
      if (camp.cleared && camp.cageT < 2) {
        camp.cageT += dt;
        camp.cage.mesh.position.y -= dt * 1.1;
        if (camp.cageT >= 2) camp.cage.mesh.visible = false;
      }
    }
    for (const c of this.world.moonstones) {
      c.t += dt;
      if (c.taken) {
        c.mesh.scale.multiplyScalar(Math.exp(-10 * dt));
        c.mesh.position.y += dt * 3;
        c.mesh.visible = c.mesh.scale.x > 0.02;
        c.beam.material.opacity = Math.max(0, c.beam.material.opacity - dt * 0.3);
        if (c.beam.material.opacity <= 0) c.beam.visible = false;
        continue;
      }
      const locked = c.lock >= 0 && !this.world.camps[c.lock].cleared;
      if (locked) c.beam.material.color.set('#ff9a7a');
      c.mesh.rotation.y = c.t * 1.6;
      c.mesh.position.y = c.base.y + Math.sin(c.t * 2.2) * 0.12;
      if (!locked && Math.hypot(c.base.x - p.x, c.base.z - p.z) < 0.95 && Math.abs(c.base.y - cy) < 1.2) {
        c.taken = true;
        this.moonFound++;
        sfx.moonstone();
        this.particles.burst('sparkle', c.mesh.position, 16, { size: 0.5, speed: 3, up: 3, life: 1.2, additive: true });
        const total = this.world.moonstones.length;
        this.hud.toast(this.moonFound === total ? 'All moonstones found! The Moon Gate opens ✨' : `Moonstone! ${this.moonFound} / ${total}`);
        this.refreshHud();
        if (this.moonFound === total) this.openGate();
      }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const h = this.pickups[i];
      h.t += dt;
      h.mesh.position.y = h.base.y + Math.sin(h.t * 3) * 0.1;
      h.mesh.quaternion.copy(this.camera.quaternion);
      if (Math.hypot(h.base.x - p.x, h.base.z - p.z) < 0.9 && Math.abs(h.base.y - cy) < 1.2 && r.hearts < r.maxHearts) {
        r.hearts++;
        sfx.heal();
        this.refreshHud();
        this.scene.remove(h.mesh);
        h.mesh.geometry.dispose();
        h.mesh.material.dispose();
        this.pickups.splice(i, 1);
      }
    }
  }

  openGate() {
    const gt = this.world.gate;
    gt.open = true;
    gt.t = 0;
    gt.beam.visible = true;
    sfx.gateOpen();
  }

  updateGate(dt) {
    const gt = this.world.gate;
    gt.emblem.material.color.setHSL(0.55, 0.8, 0.6 + 0.15 * Math.sin(performance.now() * 0.003));
    if (!gt.open) return;
    gt.t += dt;
    const u = Math.min(1, gt.t / 2.5);
    gt.door.position.y = gt.y + 2.95 - u * 6.2;
    gt.beam.material.opacity = 0.22 * u;
    if (u >= 1) {
      gt.door.visible = false;
      gt.doorBox.off = true;
      gt.portal.visible = true;
    }
    gt.portal.rotation.z -= dt * 1.5;
    const p = this.player.pos;
    if (gt.portal.visible && !this.leaving && Math.abs(p.x - gt.x) < 1.6 && Math.abs(p.z - gt.z) < 0.7 && p.y < gt.y + 3) {
      this.leaving = true;
      sfx.portal();
      this.run.moonTotal += this.moonFound;
      if (this.run.level >= LEVELS.length - 1) this.endRun('victory');
      else this.cb.onNext();
    }
  }

  updateContext() {
    const p = this.player;
    let key = '', items = null;
    const gt = this.world.gate;
    if (p.climb) {
      key = 'climb';
      items = [['claw', 'Hold to climb'], ['move', 'Down'], ['jump', 'Leap off']];
    } else if (!gt.open && Math.hypot(p.pos.x - gt.x, p.pos.z - gt.z) < 6) {
      key = `gate${this.moonFound}`;
      items = [['none', `The Moon Gate is sealed · ◆ ${this.moonFound} / ${this.world.moonstones.length}`]];
    } else {
      const b = this.birds.nearestShy(p.pos);
      const lockedNear = this.world.moonstones.find((m) => !m.taken && m.lock >= 0 && !this.world.camps[m.lock].cleared && m.base.distanceTo(p.pos) < 3);
      if (lockedNear) {
        key = 'cage';
        items = [['claw', `Defeat the guards to open the cage (${this.enemies.alive(lockedNear.lock)} left)`]];
      } else if (b) {
        key = `bird${b.trust}${b.sp.name}`;
        items = [['meow', `Meow to befriend the ${b.sp.name} ${'♥'.repeat(b.trust)}${'♡'.repeat(TRUST_NEEDED - b.trust)}`]];
      } else if (p.findTrunk()) {
        key = 'trunk';
        items = [['claw', 'Claws to climb']];
      }
    }
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.hud.setContext(items);
    }
  }

  render(dt, frozen) {
    const p = this.player;
    if (frozen) p.cat.update(dt, { speedN: 0, grounded: true, vy: 0, climb: !!p.climb });

    const fy = p.pos.y + (p.climb ? 0.7 : 0.85) * this.hero.scale;
    this.focus.x = damp(this.focus.x, p.pos.x, 18, dt);
    this.focus.z = damp(this.focus.z, p.pos.z, 18, dt);
    this.focus.y = damp(this.focus.y, fy, 10, dt);

    const cp = Math.cos(this.pitch);
    const dir = this._dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.ray.set(this.focus, dir);
    this.ray.far = this.dist;
    const hit = this.ray.intersectObjects(this.world.solids, false)[0];
    const want = hit ? Math.max(0.8, hit.distance - 0.3) : this.dist;
    this.camDist = want < this.camDist ? want : damp(this.camDist, want, 4, dt);
    const cam = this.camera.position.copy(this.focus).addScaledVector(dir, this.camDist);
    cam.y = Math.max(cam.y, this.world.groundHeight(cam.x, cam.z) + 0.4);
    this.camera.lookAt(this.focus);
    this.sky.position.copy(cam);

    this.sun.position.set(p.pos.x + 16, p.pos.y + 30, p.pos.z + 10);
    this.sun.target.position.copy(p.pos);

    this.particles.update(dt, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('click', this.onOverlayClick);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.onDeviceChange = this.prevDeviceCb;
    this.hud.hide();
    this.particles.dispose();
    disposeTree(this.scene);
  }
}
