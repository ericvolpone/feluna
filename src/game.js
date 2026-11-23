import * as THREE from 'three/webgpu';
import { makeSky } from './sky.js';
import { buildWorld } from './world.js';
import { LEVELS } from './levels.js';
import { Player } from './player.js';
import { Birds, TRUST_NEEDED, ROLES, FLOCK_TIERS, FLOCK_KINDS } from './birds.js';
import { Enemies } from './enemies.js';
import { Particles } from './particles.js';
import { Hud } from './hud.js';
import { sfx, playMusic } from './audio.js';
import { clamp, damp, dampAngle, disposeTree } from './util.js';
import { LITE } from './device.js';
import { Save } from './save.js';

const MOUSE_SENS = 0.0024;
const STICK_YAW = 2.8;
const STICK_PITCH = 1.9;

export const POWERUPS = [
  { id: 'speed', icon: '🐾', name: 'Swift Paws', desc: '+12% run & climb speed' },
  { id: 'jump', icon: '🌙', name: 'Spring Legs', desc: '+12% jump height' },
  { id: 'heart', icon: '❤️', name: 'Extra Heart', desc: '+1 max heart, fully healed' },
];

/** A run carries hearts, powerups and bird friends from level to level. */
export function newRun(hero) {
  return {
    hero, level: 0, hearts: 3, maxHearts: 3, shield: 0, speedLv: 0, jumpLv: 0,
    tunaTotal: 0, moonTotal: 0,
    friends: {}, // bird kind -> friend level
    flockTier: 0, // whole flocks befriended -> jump tier
    start: performance.now(),
  };
}

/** A run starting at `level`, restored from the save made when this hero last reached it. */
export function runFrom(hero, level = 0) {
  const run = newRun(hero);
  const snap = level > 0 ? Save.snapshotAt(hero.id, level) : null;
  if (snap) Object.assign(run, JSON.parse(JSON.stringify(snap)));
  run.level = snap ? level : 0;
  run.hearts = run.maxHearts;
  return run;
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
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, LITE ? 210 : 260);
    this.scene.fog = new THREE.Fog(L.fog[0], L.fog[1] * (LITE ? 0.85 : 1), L.fog[2] * (LITE ? 0.85 : 1));
    this.sky = makeSky({ ...L.sky, radius: 200 });
    this.scene.add(this.sky);
    this.scene.add(new THREE.HemisphereLight(L.light.sky, L.light.ground, L.light.hemi));
    this.sun = new THREE.DirectionalLight(L.light.sun, L.light.sunI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(LITE ? 1024 : 2048);
    Object.assign(this.sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 100 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.world = buildWorld(L, run.level + 1, { lite: LITE });
    this.scene.add(this.world.group);
    this.player = new Player(this.hero, this.world);
    this.scene.add(this.player.cat.root);
    this.birds = new Birds(this.scene, this.world, run.friends);
    this.enemies = new Enemies(this.scene, this.world, run.level);
    this.particles = new Particles(this.scene);
    this.pickups = [];
    this.levelTuna = 0;
    this.levelBirds = 0;
    this.flockCd = {};
    this.safePos = this.player.pos.clone();
    this.safeT = 0;
    this.checkpoint = this.world.spawn.clone();
    this.completeShown = false;
    this.mapFrame = 0;

    this.moonFound = 0;
    this.idleTime = 0;
    this.meowCd = 0;
    this.noLookT = 0;
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
    this.input.touch.setAttack(this.hero.attack.name);
    this.hud.setAttackName(this.hero.attack.name);
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
    return Object.keys(this.run.friends).length;
  }

  get mods() {
    const sp = 1 + 0.12 * this.run.speedLv;
    const tier = FLOCK_TIERS[Math.min(this.run.flockTier, FLOCK_TIERS.length - 1)];
    return {
      speedMul: sp,
      jumpMul: Math.sqrt(1 + 0.12 * this.run.jumpLv),
      climbMul: sp,
      airJumps: tier.airJumps,
      glide: tier.glide,
      touch: this.input.device === 'touch',
    };
  }

  refreshHud() {
    const r = this.run;
    this.hud.setHearts(r.hearts, r.maxHearts, r.shield);
    const st = {
      moon: this.moonFound, moonTotal: this.world.moonstones.length,
      tuna: this.levelTuna, tunaTotal: this.world.tunas.length,
      birds: this.levelBirds, birdsTotal: FLOCK_KINDS.length,
      tier: FLOCK_TIERS[Math.min(r.flockTier, FLOCK_TIERS.length - 1)].name,
    };
    this.hud.setStats(st);
    this.hud.setFlockBar(r.friends, ROLES);
    if (!this.completeShown && st.moon === st.moonTotal && st.tuna === st.tunaTotal && st.birds === st.birdsTotal) {
      this.completeShown = true;
      setTimeout(() => this.hud.banner('100% complete', `${this.level.name} ★`), 2600);
    }
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
    if (on) this.hud.setFlock(this.run.friends, ROLES, FLOCK_TIERS[Math.min(this.run.flockTier, FLOCK_TIERS.length - 1)].name);
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
    if (p.isSafe || this.ended) return;
    if (this.run.shield > 0) {
      // the Chickadee's shield takes the hit
      this.run.shield = 0;
      p.invuln = 1.0;
      if (knock) p.knock(from);
      sfx.flutter();
      this.particles.burst('feather', this._v.copy(p.pos).setY(p.pos.y + 0.7), 8, { size: 0.26, speed: 2.5, up: 1.5, life: 0.9, gravity: 1, spin: 3 });
      this.hud.toast('🛡 Shield blocked the hit!');
      this.refreshHud();
      return;
    }
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
    if (kind === 'victory') {
      sfx.gateOpen();
      Save.runCleared(this.hero.id);
    }
  }

  chooseEnd(i) {
    if (!this.ended) return;
    if (i === 0) this.cb.onRetry(this.ended.kind);
    else this.cb.onQuit();
  }

  // ── Main update ──
  update(dt, locked) {
    const s = this.input.state;
    this.input.touch.setVisible(this.input.device === 'touch' && !locked && !this.paused && !this.choice && !this.ended);
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

    // Touch: the camera eases back behind the cat while you run and aren't steering it
    if (s.touch) {
      this.noLookT = s.lookTouch ? 0 : this.noLookT + dt;
      if (this.noLookT > 0.6 && !p.climb && p.speed > 1) {
        const k = 1.4 * Math.min(1, p.speed / (p.walk || 5));
        this.yaw = dampAngle(this.yaw, p.facing + Math.PI, k, dt);
        this.pitch = damp(this.pitch, 0.3, k * 0.5, dt);
      }
      // Claw aim assist: turn toward the nearest guard in reach (Luna's pounce locks on by itself)
      if (s.clawPressed && !p.climb && this.hero.attack.type === 'claw') {
        let best = null, bd = 3;
        for (const e of this.enemies.list) {
          if (e.dead) continue;
          const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
          if (d < bd && Math.abs(e.pos.y - p.pos.y) < 1.5) {
            bd = d;
            best = e;
          }
        }
        if (best) p.facing = Math.atan2(best.pos.x - p.pos.x, best.pos.z - p.pos.z);
      }
    }
    p.update(dt, s, this.yaw, this.mods);
    this.handleEvents();
    this.updatePounce();
    this.input.touch.setCooldown(clamp(1 - p.attackCd / this.hero.attack.cooldown, 0, 1));

    // Meow
    this.meowCd -= dt;
    if (s.meowPressed && this.meowCd <= 0) {
      this.meowCd = 0.4;
      p.cat.meow();
      sfx.meow(this.hero.meowPitch ?? 1);
      this.particles.spawn('note', this._v.copy(p.pos).setY(p.pos.y + 1.3), { vel: new THREE.Vector3(0.4, 1.1, 0), size: 0.32, life: 1 });
      for (const b of this.birds.meow(p.pos, this.particles, sfx)) this.befriend(b);
    }

    this.updateHazards(dt);

    // Lava burns while you stand in it
    if (p.inLava?.kind === 'lava' && p.invuln <= 0) {
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
    const boss = this.enemies.activeBoss();
    this.hud.setBoss(boss ? boss.name : null, boss ? Math.max(0, boss.hp) / boss.maxHp : 0);
    if (res.stomped) {
      sfx.hit();
      this.particles.burst('puff', p.pos, 5, { size: 0.5, speed: 2, up: 0.5, life: 0.4 });
    }
    for (const e of res.killed) this.onKilled(e);
    this.world.camps.forEach((camp, ci) => {
      if (!camp.cleared && this.enemies.alive(ci) === 0) this.clearCamp(ci);
    });

    this.idleTime = p.grounded && !p.climb && p.speed < 0.3 ? this.idleTime + dt : 0;
    this.birds.update(dt, p, this.idleTime);
    this.updateFlock(dt);
    if (++this.mapFrame % 3 === 0) this.drawMap();
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
      } else if (e === 'attack') {
        this.doAttack();
      } else if (e === 'pounceLand') {
        // a pounce with no target bites whatever is right in front on landing
        const info = this.pounceInfo;
        if (info && !info.e && !info.hit) {
          const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
          this.reportHits(this.enemies.hitAt(p.pos.x + fx * 0.8, p.pos.z + fz * 0.8, p.pos.y, 1.0, this.hero.attack.damage, fx, fz));
        }
        this.pounceInfo = null;
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

  // ── Water, the void, checkpoints ──
  updateHazards(dt) {
    const p = this.player, W = this.world;
    // remember the last safe spot on solid ground (away from pools)
    if (p.grounded && !p.inLava && !p.climb && !W.void) {
      this.safeT += dt;
      const nearPool = W.pools.some((pl) => Math.hypot(p.pos.x - pl.x, p.pos.z - pl.z) < pl.r + 2.5);
      if (this.safeT > 0.5 && !nearPool) {
        this.safePos.copy(p.pos);
        this.safeT = 0;
      }
    }
    for (const cp of W.checkpoints) {
      if (cp.active === 'current' || p.pos.distanceTo(cp.pos) > 2.4) continue;
      for (const o of W.checkpoints) if (o.active === 'current') o.active = true;
      cp.active = 'current';
      this.checkpoint.copy(cp.pos);
      cp.lamp.material.emissive.set('#ffd36a');
      cp.lamp.material.emissiveIntensity = 2;
      sfx.heal();
      this.hud.toast('🏮 Checkpoint!');
    }
    for (const cp of W.checkpoints) cp.lamp.rotation.y += dt * (cp.active === 'current' ? 2 : 0.5);

    if (p.inLava?.kind === 'water') {
      sfx.sizzle();
      this.particles.burst('puff', p.pos, 8, { size: 0.6, speed: 2, up: 2.5, life: 0.6 });
      this.hud.toast('Splash! Cats and water don\'t mix');
      this.respawn(this.safePos);
    } else if (W.void && p.pos.y < -12) {
      this.hud.toast('Whoops! Back to the last lantern');
      this.respawn(this.checkpoint);
    }
  }

  respawn(to) {
    const p = this.player;
    const wasSafe = p.invuln > 0;
    p.pos.copy(to);
    p.vel.set(0, 0, 0);
    p.climb = null;
    p.pounce = null;
    p.inLava = null;
    p.grounded = true;
    this.focus.copy(p.pos).y += 0.9;
    if (!wasSafe) this.hurt(p.pos, false);
    p.invuln = Math.max(p.invuln, 1.2);
  }

  // ── Hero attacks ──
  doAttack() {
    const p = this.player, A = this.hero.attack;
    const fx = Math.sin(p.facing), fz = Math.cos(p.facing);
    this.birds.startle(p.pos, 3.5);
    if (A.type === 'claw') {
      p.cat.swipe();
      sfx.swipe();
      const at = this._v.set(p.pos.x + fx * A.reach, p.pos.y + 0.6 * this.hero.scale, p.pos.z + fz * A.reach);
      this.particles.spawn('slash', at, { vel: new THREE.Vector3(fx, 0, fz), size: 1.5, life: 0.24 });
      this.reportHits(this.enemies.hitAt(at.x, at.z, p.pos.y, A.radius, A.damage, fx, fz));
    } else if (A.type === 'pounce') {
      const e = this.enemies.nearest(p.pos, A.range);
      p.startPounce(e ? e.root.position.clone().setY(e.pos.y + e.hopY + 0.2) : null);
      this.pounceInfo = { e, hit: false };
      sfx.swipe();
      sfx.meow((this.hero.meowPitch ?? 1) * 1.25);
    }
  }

  /** During a locked-on pounce, bite on contact and bounce off. */
  updatePounce() {
    const p = this.player, info = this.pounceInfo;
    if (!p.pounce || !info?.e || info.hit) return;
    const e = info.e;
    if (e.dead) return;
    const cx = e.pos.x, cy = e.pos.y + e.hopY + e.height * 0.5, cz = e.pos.z;
    const d = Math.hypot(p.pos.x - cx, p.pos.y + 0.4 - cy, p.pos.z - cz);
    if (d > e.radius + 0.9) return;
    info.hit = true;
    const dx = cx - p.pos.x, dz = cz - p.pos.z, l = Math.hypot(dx, dz) || 1;
    this.enemies.damage(e, this.hero.attack.damage, dx / l, dz / l);
    this.reportHits([e]);
    p.vel.set((-dx / l) * 4.5, 7.5, (-dz / l) * 4.5);
  }

  reportHits(hits) {
    if (!hits.length) return;
    sfx.hit();
    for (const h of hits) this.particles.burst('sparkle', h.root.position.clone().setY(h.root.position.y + 0.5), 5, { size: 0.32, speed: 2, up: 1.5, life: 0.35, additive: true });
  }

  befriend(b) {
    const r = this.run;
    const kind = b.kind;
    const result = this.birds.befriend(b);
    r.friends[kind] = (r.friends[kind] ?? 0) + 1;
    this.levelBirds++;
    sfx.birdSong(b.pitch);
    const role = ROLES[kind];
    this.hud.toast(result === 'new'
      ? `♥ ${kind} joined! ${role.role}: ${role.desc}`
      : `♥ ${kind} Lv ${r.friends[kind]}! ${role.stat(r.friends[kind])}`);
    if (this.levelBirds === FLOCK_KINDS.length && r.flockTier < FLOCK_TIERS.length - 1) {
      r.flockTier++;
      const tier = FLOCK_TIERS[r.flockTier];
      setTimeout(() => {
        sfx.powerup();
        this.hud.toast(`🐦 Whole flock befriended! ${tier.toast}`);
      }, 2400);
    }
    this.refreshHud();
  }

  // ── Bird friends do their jobs ──
  updateFlock(dt) {
    const r = this.run, p = this.player, B = this.birds, cd = this.flockCd;
    for (const kind of Object.keys(r.friends)) {
      const lv = r.friends[kind];
      const b = B.follower(kind);
      cd[kind] = (cd[kind] ?? 2 + Math.random() * 2) - dt;
      const R = ROLES[kind];
      if (kind === 'Chickadee' && r.shield > 0) cd[kind] = R.cd(lv);
      if (!b || B.busy(b) || cd[kind] > 0) continue;

      if (kind === 'Cardinal') {
        // Fighter: dive-bomb the nearest guard
        cd[kind] = 0.5;
        let e = null, bd = R.range(lv);
        for (const en of this.enemies.list) {
          if (en.dead) continue;
          const d = Math.hypot(en.pos.x - p.pos.x, en.pos.z - p.pos.z);
          if (d < bd && Math.abs(en.pos.y - p.pos.y) < 3) {
            bd = d;
            e = en;
          }
        }
        if (!e) continue;
        cd[kind] = R.cd(lv);
        B.sendOnTask(b, {
          target: () => (e.dead ? null : e.root.position.clone().setY(e.root.position.y + 0.5)),
          arrive: (bb) => {
            if (e.dead) return;
            this.enemies.damage(e, 1, Math.sin(bb.yaw), Math.cos(bb.yaw));
            sfx.hit();
            this.particles.burst('feather', e.root.position.clone().setY(e.root.position.y + 0.6), 4, { size: 0.22, speed: 2, up: 1, life: 0.6, gravity: 1, spin: 3 });
          },
        });
      } else if (kind === 'Canary') {
        // Fetcher: bring back nearby tuna (and hearts when you're hurt)
        cd[kind] = R.cd(lv);
        let item = null, bd = R.range(lv), isHeart = false;
        for (const c of this.world.tunas) {
          if (c.taken || c.claimed) continue;
          const d = Math.hypot(c.base.x - p.pos.x, c.base.z - p.pos.z);
          if (d < bd && Math.abs(c.base.y - p.pos.y) < 2.5) {
            bd = d;
            item = c;
          }
        }
        if (r.hearts < r.maxHearts) {
          for (const h of this.pickups) {
            if (h.claimed) continue;
            const d = Math.hypot(h.base.x - p.pos.x, h.base.z - p.pos.z);
            if (d < bd) {
              bd = d;
              item = h;
              isHeart = true;
            }
          }
        }
        if (!item) continue;
        item.claimed = true;
        B.sendOnTask(b, {
          target: () => item.mesh.position.clone().setY(item.mesh.position.y + 0.25),
          arrive: (bb) => {
            bb.task.carry = item.mesh;
            sfx.chirp(bb.pitch);
          },
          done: () => {
            if (isHeart) this.collectHeart(item);
            else if (!item.taken) this.collectTuna(item);
          },
        });
      } else if (kind === 'Bluebird') {
        // Scout: fly toward the nearest moonstone and leave a sparkle trail
        let m = null, bd = Infinity;
        for (const ms of this.world.moonstones) {
          if (ms.taken) continue;
          const d = ms.base.distanceTo(p.pos);
          if (d < bd) {
            bd = d;
            m = ms;
          }
        }
        cd[kind] = R.cd(lv);
        if (!m || bd < 4) continue;
        const dir = m.base.clone().sub(p.pos).setY(0).normalize();
        const reach = Math.min(Math.hypot(m.base.x - p.pos.x, m.base.z - p.pos.z) - 1, R.range(lv));
        const spot = p.pos.clone().addScaledVector(dir, reach).setY(Math.max(p.pos.y, this.world.groundHeight(p.pos.x + dir.x * reach, p.pos.z + dir.z * reach)) + 2.2);
        B.sendOnTask(b, {
          target: () => spot,
          hover: 1.4,
          arrive: (bb) => {
            sfx.chirp(bb.pitch * 1.1);
            for (let i = 1; i <= 10; i++) {
              const at = spot.clone().addScaledVector(dir, i * 1.4).setY(spot.y + Math.sin(i * 0.7) * 0.3);
              this.particles.spawn('sparkle', at, { vel: new THREE.Vector3(0, 0.3, 0), size: 0.45, life: 1.2 + i * 0.12, additive: true });
            }
          },
        });
      } else if (kind === 'Robin') {
        // Healer: bring a heart when you're hurt
        if (r.hearts >= r.maxHearts) {
          cd[kind] = 2;
          continue;
        }
        cd[kind] = R.cd(lv);
        const carry = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.45), new THREE.MeshBasicMaterial({
          map: this.particles.textures.heart, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        }));
        this.scene.add(carry);
        this.pickups.push({ mesh: carry, base: carry.position, t: 0, claimed: true, carried: true });
        B.sendOnTask(b, {
          target: () => p.pos.clone().setY(p.pos.y + 1.1),
          carry,
          arrive: () => {
            const h = this.pickups.find((x) => x.mesh === carry);
            if (h) this.collectHeart(h, true);
            this.particles.burst('heart', this._v.copy(p.pos).setY(p.pos.y + 1), 4, { size: 0.3, speed: 1.2, up: 1.5, life: 0.8 });
          },
        });
      } else if (kind === 'Chickadee') {
        // Guardian: puff up a shield that blocks one hit
        r.shield = 1;
        cd[kind] = R.cd(lv);
        sfx.flutter();
        this.particles.burst('feather', b.pos, 5, { size: 0.22, speed: 1.2, up: 1, life: 0.8, gravity: 0.5, spin: 3 });
        this.hud.toast('🛡 Chickadee puffs up a shield!');
        this.refreshHud();
      }
    }
  }

  collectTuna(c) {
    if (c.taken) return;
    c.taken = true;
    this.levelTuna++;
    this.run.tunaTotal++;
    sfx.tuna();
    this.particles.burst('sparkle', c.mesh.position, 8, { size: 0.35, speed: 2, up: 2.5, life: 0.7, additive: true });
    const total = this.world.tunas.length;
    if (this.levelTuna === total) this.queueChoice('Every tuna can found!');
    else this.hud.toast(`Tuna! ${this.levelTuna} / ${total}`);
    this.refreshHud();
  }

  collectHeart(h, force = false) {
    const r = this.run;
    const i = this.pickups.indexOf(h);
    if (i < 0) return;
    if (r.hearts < r.maxHearts || force) {
      r.hearts = Math.min(r.maxHearts, r.hearts + 1);
      sfx.heal();
      this.refreshHud();
    }
    this.scene.remove(h.mesh);
    h.mesh.geometry.dispose();
    h.mesh.material.dispose();
    this.pickups.splice(i, 1);
  }

  /** Whole-level minimap: moonstones, tuna, wild birds, guard camps, the gate. */
  drawMap() {
    const cv = (this.mapCanvas ??= document.getElementById('minimap'));
    const css = cv.clientWidth;
    if (!css) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.round(css * dpr);
    if (cv.width !== size || cv.height !== size) {
      cv.width = size;
      cv.height = size;
    }
    const ctx = cv.getContext('2d');
    const S = cv.width, c = S / 2, R = c - 3 * dpr, k = R / (this.world.bounds + 2);
    const P = (x, z) => [c + x * k, c + z * k];
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(22,17,48,0.72)';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.clip();
    const dot = (x, z, r, col) => {
      const [px, py] = P(x, z);
      ctx.beginPath();
      ctx.arc(px, py, r * dpr, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    };
    // gate
    const gt = this.world.gate;
    const [gx, gy] = P(gt.x, gt.z);
    ctx.fillStyle = gt.open ? '#ffe29a' : '#a89a6a';
    ctx.fillRect(gx - 5 * dpr, gy - 3 * dpr, 10 * dpr, 6 * dpr);
    // guard camps still guarded
    this.world.camps.forEach((camp, ci) => {
      if (camp.cleared) return;
      const [cx, cy] = P(camp.x, camp.z);
      ctx.beginPath();
      ctx.arc(cx, cy, 6 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff6a5a';
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    });
    for (const t of this.world.tunas) if (!t.taken) dot(t.base.x, t.base.z, 1.7, '#ffd15a');
    for (const b of this.birds.remainingWild) dot(b.pos.x, b.pos.z, 2.6, '#9fd8ff');
    for (const m of this.world.moonstones) {
      if (m.taken) continue;
      const [mx, my] = P(m.base.x, m.base.z);
      const locked = m.lock >= 0 && !this.world.camps[m.lock].cleared;
      ctx.beginPath();
      ctx.moveTo(mx, my - 5 * dpr);
      ctx.lineTo(mx + 3.5 * dpr, my);
      ctx.lineTo(mx, my + 5 * dpr);
      ctx.lineTo(mx - 3.5 * dpr, my);
      ctx.closePath();
      ctx.fillStyle = locked ? '#ff9a7a' : '#7fe6ff';
      ctx.fill();
    }
    // camera view wedge + player arrow
    const p = this.player.pos;
    const [px, py] = P(p.x, p.z);
    const look = Math.atan2(-Math.cos(this.yaw), -Math.sin(this.yaw));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, 22 * dpr, look - 0.5, look + 0.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.translate(px, py);
    ctx.rotate(Math.PI - this.player.facing);
    ctx.beginPath();
    ctx.moveTo(0, -6 * dpr);
    ctx.lineTo(4.5 * dpr, 5 * dpr);
    ctx.lineTo(-4.5 * dpr, 5 * dpr);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
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
    if (this.world.camps.every((c) => c.cleared)) {
      this.hud.toast('All guards defeated! The cage opens');
      this.queueChoice('Every guard defeated!');
    } else this.hud.toast('Guards defeated! The cage opens');
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
      if (c.claimed) continue; // a Canary is carrying it
      c.mesh.position.y = c.base.y + Math.sin(c.t * 2.5) * 0.1;
      if (Math.hypot(c.base.x - p.x, c.base.z - p.z) < 0.85 && Math.abs(c.base.y - cy) < 1) this.collectTuna(c);
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
      h.mesh.quaternion.copy(this.camera.quaternion);
      if (h.claimed) continue;
      h.mesh.position.y = h.base.y + Math.sin(h.t * 3) * 0.1;
      if (Math.hypot(h.base.x - p.x, h.base.z - p.z) < 0.9 && Math.abs(h.base.y - cy) < 1.2 && r.hearts < r.maxHearts) this.collectHeart(h);
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
    this.input.touch.setVisible(false);
    this.hud.hide();
    this.particles.dispose();
    disposeTree(this.scene);
  }
}
