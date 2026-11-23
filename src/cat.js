import * as THREE from 'three/webgpu';
import { paint, damp, lerp } from './util.js';

/**
 * Procedural low-poly cat. The model is a hierarchy of pivots (body → head/legs/tail
 * chain) so it can be animated procedurally: idle breathing, head looking around,
 * blinking, ear twitches, a trot/gallop gait, jump/fall poses and landing squash.
 *
 * Origin is at the feet, facing +Z.
 */
export class Cat {
  constructor(hero) {
    this.hero = hero;
    const P = {};
    for (const [k, v] of Object.entries(hero.palette)) P[k] = new THREE.Color(v);

    const fur = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: hero.furRoughness ?? 0.85,
      metalness: 0,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: P.eye, emissive: P.eye, emissiveIntensity: 0.55, roughness: 0.25,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#0b0a0e', roughness: 0.3 });
    const shineMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const whiskerMat = new THREE.MeshBasicMaterial({ color: P.whisker });
    const collarMat = new THREE.MeshStandardMaterial({ color: P.collar, flatShading: true, roughness: 0.5 });
    const charmMat = new THREE.MeshStandardMaterial({
      color: P.charm, emissive: P.charm, emissiveIntensity: 0.15,
      metalness: 0.7, roughness: 0.3, flatShading: true,
    });

    const add = (parent, geo, color, mat = fur) => {
      const g = mat === fur ? paint(geo, typeof color === 'function' ? color : () => color) : geo;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    this.root = new THREE.Group();
    this.rig = new THREE.Group();
    this.rig.scale.setScalar(hero.scale);
    this.root.add(this.rig);

    // ── Body ────────────────────────────────────────────────
    this.body = new THREE.Group();
    this.body.position.set(0, 0.55, 0);
    this.rig.add(this.body);
    const g = hero.build?.girth ?? 1;
    const gy = 1 + (g - 1) * 0.5;
    add(this.body, new THREE.IcosahedronGeometry(0.5, 1).scale(0.44 * g, 0.4 * gy, 0.95),
      (p) => (p.y < -0.06 || (p.z > 0.28 && p.y < 0.14) ? P.belly : P.top));
    if (g > 1.05) {
      // round, low-slung belly
      add(this.body, new THREE.IcosahedronGeometry(0.5, 1).scale(0.42 * g, 0.3 * g, 0.66).translate(0, -0.1, 0.02), P.belly);
    }
    // haunches give the silhouette a cat-like rear
    for (const s of [-1, 1]) {
      add(this.body, new THREE.IcosahedronGeometry(0.17, 0).scale(0.9 * g, 1.1, 1.2).translate(s * 0.13 * g, -0.04, -0.3),
        (p) => (p.y < -0.12 ? P.belly : P.top));
    }

    // ── Head ────────────────────────────────────────────────
    this.head = new THREE.Group();
    this.head.position.set(0, 0.3, 0.5);
    this.body.add(this.head);
    add(this.head, new THREE.IcosahedronGeometry(0.3, 1).scale(1.1, 0.92, 0.95),
      (p) => (p.y > -0.02 || p.z < -0.06 ? P.top : P.belly));
    for (const s of [-1, 1]) {
      add(this.head, new THREE.IcosahedronGeometry(0.12, 0).scale(1, 0.8, 0.9).translate(s * 0.14, -0.1, 0.13), P.belly);
    }
    add(this.head, new THREE.SphereGeometry(0.1, 6, 4).scale(1.3, 0.7, 0.8).translate(0, -0.1, 0.24), P.belly);
    add(this.head, new THREE.ConeGeometry(0.038, 0.035, 3).rotateX(Math.PI).rotateY(Math.PI).translate(0, -0.045, 0.32), P.nose);

    this.mouth = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), new THREE.MeshStandardMaterial({ color: '#5a2430', roughness: 0.6 }));
    this.mouth.position.set(0, -0.14, 0.27);
    this.mouth.scale.set(1, 0.05, 0.6);
    this.head.add(this.mouth);

    // Eyes
    this.eyes = [];
    for (const s of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(s * 0.115, 0.03, 0.245);
      eye.rotation.y = s * 0.3;
      this.head.add(eye);
      eye.add(new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8).scale(1, 1.1, 0.5), eyeMat));
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6).scale(0.5, 1.5, 0.4), darkMat);
      pupil.position.z = 0.026;
      eye.add(pupil);
      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.013, 5, 4), shineMat);
      shine.position.set(0.016, 0.03, 0.036);
      eye.add(shine);
      if (hero.lashes) {
        for (let i = 0; i < 2; i++) {
          const lash = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.012, 0.012), darkMat);
          lash.position.set(s * (0.05 + i * 0.012), 0.055 - i * 0.018, 0.01);
          lash.rotation.z = s * (0.35 + i * 0.4);
          eye.add(lash);
        }
      }
      this.eyes.push(eye);
    }

    // Ears
    this.ears = [];
    for (const s of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(s * 0.16, 0.19, -0.03);
      ear.userData.side = s;
      this.head.add(ear);
      add(ear, new THREE.ConeGeometry(0.11, 0.24, 4).rotateY(Math.PI / 4).translate(0, 0.11, 0), P.top);
      add(ear, new THREE.ConeGeometry(0.065, 0.16, 3).rotateY(Math.PI).translate(0, 0.08, 0.035), P.earInner);
      this.ears.push(ear);
    }

    // Whiskers
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.006, 0.006), whiskerMat);
        w.position.set(s * 0.21, -0.105 + (i - 1) * 0.025, 0.24);
        w.rotation.set(0, -s * 0.25, s * (i - 1) * 0.15);
        this.head.add(w);
      }
    }

    // Collar + charm
    if (hero.build?.collar !== false) {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 4, 12), collarMat);
    collar.position.set(0, 0.2, 0.42);
    collar.rotation.x = -0.6;
    collar.castShadow = true;
    this.body.add(collar);
    const charm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), charmMat);
    charm.position.set(0, -0.2, 0.04);
    collar.add(charm);
    }

    // ── Legs ────────────────────────────────────────────────
    const makeLeg = (x, z, hind) => {
      const hip = new THREE.Group();
      hip.position.set(x, -0.085, z);
      this.body.add(hip);
      const upper = hind
        ? new THREE.CylinderGeometry(0.1, 0.065, 0.26, 6)
        : new THREE.CylinderGeometry(0.075, 0.06, 0.26, 6);
      add(hip, upper.translate(0, -0.12, 0), hind ? P.hindLegs : P.frontLegs);
      const knee = new THREE.Group();
      knee.position.set(0, -0.23, 0);
      hip.add(knee);
      add(knee, new THREE.CylinderGeometry(0.055, 0.05, 0.2, 6).translate(0, -0.1, 0), P.sock);
      add(knee, new THREE.SphereGeometry(0.07, 6, 4).scale(1, 0.5, 1.3).translate(0, -0.2, 0.025), P.sock);
      return { hip, knee, hind };
    };
    const lx = 0.17 * (1 + (g - 1) * 0.6);
    this.legs = [
      { ...makeLeg(-lx, 0.33, false), off: 0 },
      { ...makeLeg(lx, 0.33, false), off: Math.PI },
      { ...makeLeg(-lx, -0.33, true), off: Math.PI },
      { ...makeLeg(lx, -0.33, true), off: 0 },
    ];

    // ── Tail (chain of segments) ────────────────────────────
    this.tail = [];
    let parent = new THREE.Group();
    parent.position.set(0, 0.12, -0.44);
    this.body.add(parent);
    const N = 6, segLen = 0.12;
    for (let i = 0; i < N; i++) {
      const seg = new THREE.Group();
      if (i > 0) seg.position.z = -segLen;
      parent.add(seg);
      const r0 = lerp(0.055, 0.03, i / N), r1 = lerp(0.055, 0.03, (i + 1) / N);
      add(seg, new THREE.CylinderGeometry(r1, r0, segLen * 1.08, 5).translate(0, segLen / 2, 0).rotateX(-Math.PI / 2),
        i === N - 1 ? P.tailTip : P.top);
      this.tail.push(seg);
      parent = seg;
    }

    // ── Animation state ─────────────────────────────────────
    this.t = Math.random() * 10;
    this.phase = 0;
    this.run = 0;
    this.air = 0;
    this.squash = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.blink = 0;
    this.lookTimer = 1;
    this.lookYaw = 0;
    this.lookTarget = 0;
    this.earTwitch = [0, 0];
    this.earTimer = 3;
    this.climbT = 0;
    this.climbPhase = 0;
    this.swipeT = 0;
    this.meowT = 0;
  }

  /** Quick claw swipe with the front-right paw. */
  swipe() {
    this.swipeT = 0.28;
  }

  meow() {
    this.meowT = 0.55;
  }

  /** Landing squash; intensity 0..1 */
  land(intensity = 0.6) {
    this.squash = Math.max(this.squash, intensity);
  }

  /**
   * @param {number} dt
   * @param {object} st
   * @param {number} [st.speedN]  horizontal speed / walk speed (1 = run, >1 = sprint)
   * @param {boolean} [st.grounded]
   * @param {number} [st.vy]
   * @param {boolean} [st.climb]  latched onto a tree trunk
   * @param {number} [st.climbSpeed]  -1..1 climbing direction/speed
   * @param {boolean} [st.glide]
   * @param {boolean} [st.excited]
   */
  update(dt, st = {}) {
    const speedN = st.speedN ?? 0;
    const grounded = st.grounded ?? true;
    const vy = st.vy ?? 0;
    this.t += dt;
    const t = this.t;

    this.climbT = damp(this.climbT, st.climb ? 1 : 0, 14, dt);
    const cl = this.climbT;
    this.air = damp(this.air, grounded || st.climb ? 0 : 1, 14, dt);
    this.run = damp(this.run, st.climb ? 0 : speedN, 10, dt);
    const run = Math.min(this.run, 1.6);
    const r1 = Math.min(run, 1);
    const idle = 1 - r1;
    const air = this.air;
    const glide = st.glide ? 1 : 0;

    // Gait
    const freq = 2 + 9 * r1 + Math.max(0, run - 1) * 6;
    if (grounded) this.phase += dt * freq;
    const cs = st.climbSpeed ?? 0;
    this.climbPhase += dt * Math.abs(cs) * 9;
    const amp = 0.7 * Math.min(run, 1.25);
    const rising = vy > 0;
    for (const leg of this.legs) {
      const s = Math.sin(this.phase + leg.off);
      const c = Math.cos(this.phase + leg.off);
      let hipX = -s * amp;
      let kneeX = (leg.hind ? -1 : 1) * Math.max(0, c) * amp * 1.1;
      const airHip = leg.hind ? (rising ? 0.9 : glide ? 1.2 : 0.35) : (rising ? -0.95 : glide ? -1.3 : -0.45);
      const airKnee = leg.hind ? (rising ? -0.9 : glide ? -0.1 : -0.2) : (rising ? 1.0 : glide ? 0.1 : 0.25);
      hipX = lerp(hipX, airHip, air);
      kneeX = lerp(kneeX, airKnee, air);
      // clinging to a trunk: paws reach "forward" (up the trunk), alternating while moving
      const cs2 = Math.sin(this.climbPhase + leg.off);
      const cHip = (leg.hind ? 0.15 : -0.75) - cs2 * 0.5 * Math.min(1, Math.abs(cs) * 2);
      const cKnee = (leg.hind ? -0.6 : 0.7) + Math.max(0, Math.cos(this.climbPhase + leg.off)) * 0.4 * Math.min(1, Math.abs(cs) * 2);
      leg.hip.rotation.x = lerp(hipX, cHip, cl);
      leg.knee.rotation.x = lerp(kneeX, cKnee, cl);
      leg.hip.rotation.z = 0;
    }

    // Swipe overrides the front-right paw
    if (this.swipeT > 0) {
      this.swipeT -= dt;
      const u = Math.max(0, 1 - this.swipeT / 0.28);
      const k = Math.sin(Math.PI * u);
      const fr = this.legs[1];
      fr.hip.rotation.x = lerp(fr.hip.rotation.x, -2.2, k);
      fr.hip.rotation.z = -0.5 * k;
      fr.knee.rotation.x = lerp(fr.knee.rotation.x, 0.2, k);
      this.body.rotation.y = 0.25 * k;
    } else {
      this.body.rotation.y = 0;
    }

    // Whole-rig pitch for climbing (nose up the trunk, belly against it)
    this.rig.rotation.x = -1.45 * cl;
    this.rig.position.y = 0.5 * cl;

    // Body bob, pitch and breathing
    const breath = Math.sin(t * 2.2);
    this.body.position.y = 0.55 + Math.abs(Math.sin(this.phase)) * 0.045 * r1 * (1 - air) + breath * 0.006 * idle;
    this.body.rotation.x = lerp(lerp(Math.sin(this.phase * 2) * 0.03 * r1, rising ? -0.28 : glide ? 0.05 : 0.12, air), 0, cl);
    const bs = 1 + breath * 0.012 * idle;
    this.body.scale.set(bs, bs, 1);

    // Head: idle looking around, counter-bob while running, meow tilt
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 1.8 + Math.random() * 2.5;
      this.lookTarget = (Math.random() - 0.5) * (st.excited ? 0.4 : 1.0);
    }
    this.lookYaw = damp(this.lookYaw, this.lookTarget * idle * (1 - cl), 4, dt);
    let meow = 0;
    if (this.meowT > 0) {
      this.meowT -= dt;
      meow = Math.sin(Math.PI * Math.max(0, 1 - this.meowT / 0.55));
    }
    this.head.rotation.y = this.lookYaw;
    this.head.rotation.x = lerp(-Math.sin(this.phase * 2) * 0.05 * r1, rising ? 0.18 : -0.1, air) - meow * 0.45 + cl * 0.25;
    this.head.rotation.z = Math.sin(t * 0.7) * 0.07 * idle * (1 - cl);
    this.mouth.scale.y = 0.05 + meow * 0.9;

    // Tail: high and curly at rest, streams back when running, hangs down when climbing
    for (let i = 0; i < this.tail.length; i++) {
      const seg = this.tail[i];
      const restX = i === 0 ? 0.95 : -0.08 + (i >= 4 ? -0.12 : 0);
      const runX = i === 0 ? 0.35 : 0.03;
      let x = lerp(restX, runX, r1) + (i === 0 ? air * 0.35 : 0);
      x = lerp(x, i === 0 ? -0.2 : 0.02, cl);
      seg.rotation.x = x;
      const swish = lerp(st.excited ? 0.35 : 0.22, 0.1, r1);
      seg.rotation.y = Math.sin(t * (2 + run * 4 + (st.excited ? 3 : 0)) - i * 0.7) * swish;
    }

    // Ears: occasional twitch, flatten back when running, perk up on meow
    this.earTimer -= dt;
    if (this.earTimer <= 0) {
      this.earTimer = 2 + Math.random() * 4;
      this.earTwitch[Math.random() < 0.5 ? 0 : 1] = 1;
    }
    this.ears.forEach((ear, i) => {
      const s = ear.userData.side;
      this.earTwitch[i] = damp(this.earTwitch[i], 0, 9, dt);
      ear.rotation.z = -s * (0.3 + this.earTwitch[i] * 0.45 - meow * 0.15);
      ear.rotation.x = -0.35 * r1 - air * 0.2 - cl * 0.2;
    });

    // Blink
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blink = 0.14;
      this.blinkTimer = 2 + Math.random() * 4;
    }
    if (this.blink > 0) this.blink -= dt;
    const eyeY = this.blink > 0 || meow > 0.3 ? 0.12 : 1;
    for (const e of this.eyes) e.scale.y = eyeY;

    // Squash & stretch
    this.squash = damp(this.squash, 0, 9, dt);
    const sc = this.hero.scale;
    const stretch = air * Math.max(-1, Math.min(1, vy / 10)) * 0.06;
    this.rig.scale.set(
      sc * (1 + 0.12 * this.squash - stretch * 0.5),
      sc * (1 - 0.22 * this.squash + stretch),
      sc * (1 + 0.12 * this.squash - stretch * 0.5),
    );
  }
}
