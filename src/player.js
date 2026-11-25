import * as THREE from 'three/webgpu';
import { Cat } from './cat.js';
import { clamp, dampAngle } from './util.js';

const GRAVITY = 28;
const STEP = 0.3;
const COYOTE = 0.1;
const BUFFER = 0.13;
const GRAB_REACH = 0.55;
const GLIDE_FALL = 2.4;

/**
 * Third-person kinematic character.
 * - camera-relative movement, buffered jump with coyote time and variable height
 * - claw swipe next to a trunk latches on; hold claws (or push up) to climb
 * - optional air jumps (flutter) and glide granted by bird friends
 *
 * `events` collects one-frame happenings (jump, land, swipe, latch, mount, flutter)
 * for the game to turn into sound and particles.
 */
export class Player {
  constructor(hero, world) {
    this.hero = hero;
    this.world = world;
    this.cat = new Cat(hero);
    this.pos = world.spawn.clone();
    this.pos.y = world.groundHeight(this.pos.x, this.pos.z);
    this.vel = new THREE.Vector3();
    this.radius = 0.36 * hero.scale * (hero.build?.girth > 1.1 ? 1.08 : 1);
    this.height = 1.0 * hero.scale;
    this.grounded = true;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.airJumpsLeft = 0;
    this.facing = Math.PI;
    this.climb = null;
    this.regrab = 0;
    this.gliding = false;
    this.events = [];
    this.invuln = 0;
    this.attackCd = 0;
    this.pounce = null; // { t, target, hit }
    this.safeT = 0; // brief invulnerability after a pounce
    this.stepPhase = 0;
    this.speed = 0;
    this.inLava = null;
    this.cat.root.position.copy(this.pos);
    this.cat.root.rotation.y = this.facing;
  }

  /** Nearest climbable trunk within reach, or null. */
  findTrunk() {
    const p = this.pos;
    let best = null, bestD = Infinity;
    for (const c of this.world.circles) {
      if (!c.climb || c.off) continue;
      const d = Math.hypot(p.x - c.x, p.z - c.z) - c.r - this.radius;
      if (d > GRAB_REACH || d >= bestD) continue;
      if (p.y < c.y0 || p.y > c.climb.top + 0.3) continue;
      best = c;
      bestD = d;
    }
    return best;
  }

  /**
   * @param {object} s  input state
   * @param {number} camYaw
   * @param {{speedMul:number, jumpMul:number, climbMul:number, airJumps:number, glide:boolean}} mods
   */
  update(dt, s, camYaw, mods) {
    this.events.length = 0;
    this.regrab -= dt;
    this.invuln -= dt;
    this.attackCd -= dt;
    this.safeT -= dt;
    this.cat.root.visible = this.invuln <= 0 || Math.floor(this.invuln * 14) % 2 === 0;

    // The claw button latches onto a trunk if you're next to one, otherwise attacks
    if (s.clawPressed && !this.climb && !this.pounce) {
      const trunk = this.regrab <= 0 ? this.findTrunk() : null;
      if (trunk) {
        this.cat.swipe();
        this.events.push('swipe');
        this.latch(trunk);
      } else if (this.attackCd <= 0) {
        this.attackCd = this.hero.attack.cooldown;
        this.events.push('attack');
      }
    }

    if (this.climb) this.updateClimb(dt, s, camYaw, mods);
    else this.updateMove(dt, s, camYaw, mods);
  }

  /** Can't be hurt right now (blinking after a hit, or mid-pounce). */
  get isSafe() {
    return this.invuln > 0 || !!this.pounce || this.safeT > 0;
  }

  /** Leap at target (a Vector3) or, with no target, a short pounce forward. */
  startPounce(target) {
    const T = 0.42;
    if (target) {
      const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
      const dy = target.y - this.pos.y;
      this.vel.set(dx / T, Math.min(14, (dy + 0.5 * GRAVITY * T * T) / T), dz / T);
      this.facing = Math.atan2(dx, dz);
    } else {
      this.vel.set(Math.sin(this.facing) * 7.5, 6.5, Math.cos(this.facing) * 7.5);
    }
    this.pounce = { t: 0, target, hit: false };
    this.grounded = false;
    this.cat.meow();
    this.events.push('pounce');
  }

  /** Pushed away from a hit. */
  knock(from) {
    const dx = this.pos.x - from.x, dz = this.pos.z - from.z, d = Math.hypot(dx, dz) || 1;
    if (this.climb) {
      this.climb = null;
      this.regrab = 0.5;
    }
    this.vel.set((dx / d) * 7, 6.5, (dz / d) * 7);
    this.grounded = false;
  }

  latch(c) {
    const m = c.climb.mountTo;
    const ang = m ? Math.atan2(c.z - m.z, c.x - m.x) : Math.atan2(this.pos.z - c.z, this.pos.x - c.x);
    this.climb = { c, ang };
    this.pos.y = Math.max(this.pos.y, this.world.groundHeight(this.pos.x, this.pos.z) + 0.2);
    this.vel.set(0, 0, 0);
    this.grounded = false;
    this.airJumpsLeft = 0;
    this.events.push('latch');
  }

  updateClimb(dt, s, camYaw, mods) {
    const { c } = this.climb;
    const rate = this.hero.stats.climb * mods.climbMul;
    let vy = 0;
    if (s.claw) vy = rate;
    else if (s.move.y > 0.3) vy = rate * s.move.y;
    else if (s.move.y < -0.3) vy = rate * 1.8 * s.move.y;

    // Circle the trunk: stick right moves the cat right on screen
    const R = c.r + 0.12;
    const tx = -Math.sin(this.climb.ang), tz = Math.cos(this.climb.ang);
    const rightDot = tx * Math.cos(camYaw) - tz * Math.sin(camYaw);
    const around = c.climb.mountTo ? 0 : s.move.x * (rightDot >= 0 ? 1 : -1) * 2.2;
    this.climb.ang += (around / R) * dt;

    const dx = Math.cos(this.climb.ang), dz = Math.sin(this.climb.ang);
    this.pos.x = c.x + dx * R;
    this.pos.z = c.z + dz * R;
    this.pos.y = Math.max(this.pos.y + vy * dt, this.world.groundHeight(this.pos.x, this.pos.z));
    this.facing = Math.atan2(-dx, -dz);

    const ground = this.world.groundHeight(this.pos.x, this.pos.z);
    if (s.jumpPressed) {
      // leap off, away from the trunk (nudged by the stick)
      this.climb = null;
      this.regrab = 0.35;
      const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
      const ix = cy * s.move.x - sy * s.move.y, iz = -sy * s.move.x - cy * s.move.y;
      this.vel.set(dx * 4.5 + ix * 2.5, this.hero.stats.jump * mods.jumpMul * 0.85, dz * 4.5 + iz * 2.5);
      this.facing = Math.atan2(this.vel.x, this.vel.z);
      this.airJumpsLeft = mods.airJumps;
      this.events.push('jump');
    } else if (this.pos.y <= ground + 0.02 && vy < 0) {
      this.pos.y = ground;
      this.climb = null;
      this.grounded = true;
      this.facing = Math.atan2(dx, dz);
    } else if (this.pos.y >= c.climb.top) {
      if (c.climb.mountY != null) {
        // pull up onto the canopy platform
        const m = c.climb.mountTo;
        if (m) {
          // drainpipe: step onto the roof, toward the building's middle
          const mx = m.x - c.x, mz = m.z - c.z, ml = Math.hypot(mx, mz) || 1;
          this.pos.set(c.x + (mx / ml) * 1.1, c.climb.mountY, c.z + (mz / ml) * 1.1);
          this.facing = Math.atan2(mx, mz);
        } else {
          const d = Math.min(c.r + 0.7, c.climb.platR - 0.5);
          this.pos.set(c.x + dx * d, c.climb.mountY, c.z + dz * d);
          this.facing = Math.atan2(dx, dz);
        }
        this.climb = null;
        this.grounded = true;
        this.vel.set(0, 0, 0);
        this.cat.land(0.5);
        this.events.push('mount');
      } else {
        this.pos.y = c.climb.top;
        vy = 0;
      }
    }

    this.cat.root.position.copy(this.pos);
    this.cat.root.rotation.y = this.facing;
    this.cat.update(dt, { climb: !!this.climb, climbSpeed: vy / rate, grounded: true });
    const cp = Math.floor(this.cat.climbPhase / Math.PI);
    if (cp !== this.stepPhase) {
      this.stepPhase = cp;
      if (this.climb && vy !== 0) this.events.push('climbstep');
    }
  }

  updateMove(dt, s, camYaw, mods) {
    const { stats } = this.hero;
    const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
    // camera-relative: forward = (-sin, -cos), right = (cos, -sin)
    const dx = cy * s.move.x - sy * s.move.y;
    const dz = -sy * s.move.x - cy * s.move.y;
    const mag = Math.min(1, Math.hypot(s.move.x, s.move.y));
    const sprinting = s.sprint && mag > 0.1;
    const walk = stats.speed * mods.speedMul;
    this.walk = walk;
    const maxSpeed = walk * (sprinting ? stats.sprint : 1);
    const dl = Math.hypot(dx, dz) || 1;
    const tx = (dx / dl) * mag * maxSpeed, tz = (dz / dl) * mag * maxSpeed;

    const accel = (this.pounce ? 0 : this.grounded ? 48 : 16) * dt;
    const ex = tx - this.vel.x, ez = tz - this.vel.z;
    const el = Math.hypot(ex, ez);
    if (this.pounce) {
      // committed to the leap
    } else if (el > accel) {
      this.vel.x += (ex / el) * accel;
      this.vel.z += (ez / el) * accel;
    } else {
      this.vel.x = tx;
      this.vel.z = tz;
    }

    // Jump (buffered + coyote + variable height), then flutter air jumps
    const jumpV = stats.jump * mods.jumpMul;
    // touch gets a little extra forgiveness on jump timing
    const ease = mods.touch ? 1.6 : 1;
    this.jumpBuffer = s.jumpPressed ? BUFFER * ease : this.jumpBuffer - dt;
    this.coyote = this.grounded ? COYOTE * ease : this.coyote - dt;
    if (this.grounded) this.airJumpsLeft = mods.airJumps;
    if (this.pounce) {
      this.jumpBuffer = 0;
    } else if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.y = jumpV;
      this.grounded = false;
      this.coyote = this.jumpBuffer = 0;
      this.events.push('jump');
    } else if (s.jumpPressed && !this.grounded && this.airJumpsLeft > 0) {
      this.vel.y = jumpV * 0.82;
      this.airJumpsLeft--;
      this.jumpBuffer = 0;
      this.cat.land(0.3);
      this.events.push('flutter');
    }
    const cut = !s.jump && this.vel.y > 0 && !this.pounce ? 1.8 : 0;
    this.vel.y = Math.max(-30, this.vel.y - GRAVITY * (1 + cut) * dt);
    this.gliding = mods.glide && s.jump && !this.grounded && this.vel.y < -GLIDE_FALL;
    if (this.gliding) this.vel.y = -GLIDE_FALL;

    const wasGrounded = this.grounded;
    const landVy = this.vel.y;
    this.collide(dt, wasGrounded);
    if (this.pounce) {
      this.pounce.t += dt;
      if ((this.grounded && this.pounce.t > 0.08) || this.pounce.t > 2) {
        this.events.push('pounceLand');
        this.pounce = null;
        this.safeT = 0.35;
      }
    }
    if (!wasGrounded && this.grounded) {
      this.cat.land(clamp(-landVy / 16, 0.15, 1));
      this.events.push(landVy < -8 ? 'land' : 'softland');
    }
    if (this.pos.y < -30) {
      this.pos.copy(this.world.spawn);
      this.vel.set(0, 0, 0);
    }

    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.4) this.facing = dampAngle(this.facing, Math.atan2(this.vel.x, this.vel.z), 14, dt);
    this.speed = hs;

    this.cat.root.position.copy(this.pos);
    this.cat.root.rotation.y = this.facing;
    this.cat.update(dt, { speedN: hs / walk, grounded: this.grounded, vy: this.vel.y, glide: this.gliding });
    const ph = Math.floor(this.cat.phase / Math.PI);
    if (ph !== this.stepPhase) {
      this.stepPhase = ph;
      if (this.grounded && hs > 0.8) this.events.push('step');
    }

    // standing in lava?
    this.inLava = null;
    // only when standing on the pool's own floor, not on a lily pad or pillar above it
    const onTerrain = this.pos.y < this.world.groundHeight(this.pos.x, this.pos.z) + 0.15;
    if (this.grounded && onTerrain) {
      for (const pl of this.world.pools) {
        if (this.pos.y < pl.lavaY + 0.2 && Math.hypot(this.pos.x - pl.x, this.pos.z - pl.z) < pl.r + 0.6) this.inLava = pl;
      }
    }
  }

  collide(dt, wasGrounded) {
    const { boxes, circles, bounds, groundHeight } = this.world;
    const p = this.pos, r = this.radius, H = this.height;

    // Horizontal
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    for (const b of boxes) {
      if (b.off || p.y + H <= b.min.y || p.y >= b.max.y - 1e-3) continue;
      const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
      const ox = p.x - cx, oz = p.z - cz;
      const d2 = ox * ox + oz * oz;
      if (d2 >= r * r) continue;
      if (wasGrounded && b.max.y - p.y <= STEP) {
        p.y = b.max.y;
        continue;
      }
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x += (ox / d) * (r - d);
        p.z += (oz / d) * (r - d);
      } else {
        const pen = [p.x - b.min.x + r, b.max.x - p.x + r, p.z - b.min.z + r, b.max.z - p.z + r];
        const i = pen.indexOf(Math.min(...pen));
        if (i === 0) p.x = b.min.x - r; else if (i === 1) p.x = b.max.x + r;
        else if (i === 2) p.z = b.min.z - r; else p.z = b.max.z + r;
      }
    }
    for (const c of circles) {
      if (c.off || p.y + H <= c.y0 || p.y >= c.y1 - 1e-3) continue;
      const ox = p.x - c.x, oz = p.z - c.z;
      const min = c.r + r;
      if (Math.abs(ox) > min || Math.abs(oz) > min) continue;
      const d = Math.hypot(ox, oz);
      if (d >= min) continue;
      if (wasGrounded && c.y1 - p.y <= STEP) {
        p.y = c.y1;
        continue;
      }
      const nx = d > 1e-6 ? ox / d : 1, nz = d > 1e-6 ? oz / d : 0;
      p.x = c.x + nx * min;
      p.z = c.z + nz * min;
    }
    const rr = Math.hypot(p.x, p.z);
    if (rr > bounds) {
      p.x *= bounds / rr;
      p.z *= bounds / rr;
    }

    // Vertical
    const prevY = p.y;
    p.y += this.vel.y * dt;
    let ground = groundHeight(p.x, p.z);
    const fr = r * 0.6;
    for (const b of boxes) {
      if (b.off || b.max.y > prevY + 0.05 || b.max.y <= ground) continue;
      if (p.x + fr < b.min.x || p.x - fr > b.max.x || p.z + fr < b.min.z || p.z - fr > b.max.z) continue;
      ground = b.max.y;
    }
    for (const c of circles) {
      if (c.off || c.y1 > prevY + 0.05 || c.y1 <= ground) continue;
      const ox = p.x - c.x, oz = p.z - c.z, m = c.r + fr;
      if (Math.abs(ox) > m || Math.abs(oz) > m) continue;
      if (ox * ox + oz * oz < m * m) ground = c.y1;
    }
    const snap = wasGrounded && this.vel.y <= 0 && p.y - ground < STEP;
    if (p.y <= ground || snap) {
      p.y = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Ceiling
    if (this.vel.y > 0) {
      for (const b of boxes) {
        if (b.off || b.min.y < prevY + H - 0.05 || p.y + H <= b.min.y) continue;
        if (p.x + fr < b.min.x || p.x - fr > b.max.x || p.z + fr < b.min.z || p.z - fr > b.max.z) continue;
        p.y = b.min.y - H;
        this.vel.y = 0;
      }
      for (const c of circles) {
        if (c.off || c.y0 < prevY + H - 0.05 || p.y + H <= c.y0) continue;
        if (Math.hypot(p.x - c.x, p.z - c.z) > c.r + fr) continue;
        p.y = c.y0 - H;
        this.vel.y = 0;
      }
    }
  }
}
