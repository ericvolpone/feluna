import * as THREE from 'three/webgpu';
import { Cat } from './cat.js';
import { HEROES } from './heroes.js';
import { LEVELS } from './levels.js';
import { Save } from './save.js';
import { makeSky } from './sky.js';
import { TextPanel, FONT, frustumHalf, drawPrompts, roundRect, wrapText } from './ui3d.js';
import { paint, damp, mulberry32, disposeTree } from './util.js';

const HUD_DIST = 2;

/** On phones, go fullscreen and lock landscape when supported (Android Chrome). */
function requestFullscreenLandscape() {
  try {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
      .catch(() => {});
  } catch { /* not supported (e.g. iPhone Safari) */ }
}

/**
 * Title screen and hero select, rendered entirely in the 3D scene:
 * a floating island under a moonlit sky with both cats on pedestals.
 * All text is canvas-textured quads attached to the camera.
 */
export class MenuScene {
  constructor(input, { onStart }) {
    this.input = input;
    this.onStart = onStart;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 600);
    this.scene.add(this.camera);
    this.scene.fog = new THREE.Fog('#2b2457', 25, 140);
    this.sky = makeSky({ top: '#070722', horizon: '#4a3a7a', ground: '#15112b' });
    this.scene.add(this.sky);

    this.buildLights();
    this.buildWorld();
    this.buildCats();
    this.buildUI();

    this.t = 0;
    this.camPos = new THREE.Vector3(0, 3, 10);
    this.camLook = new THREE.Vector3(0, 2.6, 0);
    this.reset();
    input.onDeviceChange = () => this.redrawUI();
  }

  reset() {
    this.state = 'title';
    this.starting = false;
    this.startTimer = 0;
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight('#9aa8ff', '#2a1e3a', 1.1));
    const moon = new THREE.DirectionalLight('#d6deff', 2.4);
    moon.position.set(4, 9, 7);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    Object.assign(moon.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 30 });
    moon.shadow.bias = -0.0005;
    moon.shadow.normalBias = 0.02;
    this.scene.add(moon);
    // cool rim light from behind so the black cat reads against the night
    const rim = new THREE.DirectionalLight('#7fa8ff', 3.2);
    rim.position.set(-3, 4, -8);
    this.scene.add(rim);
    this.spot = new THREE.SpotLight('#fff1d0', 30, 12, 0.45, 0.6, 1.2);
    this.spot.position.set(0, 6, 3);
    this.scene.add(this.spot, this.spot.target);
  }

  buildWorld() {
    const rand = mulberry32(42);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
    const grass = ['#4f8a5b', '#5a9763', '#46804f'].map((c) => new THREE.Color(c));
    const rock = ['#5c5470', '#4d465f', '#665d7b'].map((c) => new THREE.Color(c));

    // Floating island
    const top = new THREE.CylinderGeometry(6, 4.6, 1.2, 11, 2).translate(0, -0.6, 0);
    const under = new THREE.ConeGeometry(4.6, 5, 9, 3).rotateX(Math.PI).translate(0, -3.7, 0);
    const pos = under.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > -1.3) continue;
      pos.setX(i, pos.getX(i) * (0.8 + rand() * 0.4));
      pos.setZ(i, pos.getZ(i) * (0.8 + rand() * 0.4));
    }
    for (const g of [top, under]) {
      const m = new THREE.Mesh(paint(g, (p) => (p.y > -0.05 ? grass[(Math.abs(p.x * 3 + p.z * 7) | 0) % 3] : rock[(Math.abs(p.y * 2) | 0) % 3])), mat);
      m.receiveShadow = true;
      this.scene.add(m);
    }

    // Grass tufts
    const tuftGeo = new THREE.ConeGeometry(0.07, 0.3, 3);
    const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }), 90);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      const a = rand() * Math.PI * 2, r = 2 + rand() * 3.7;
      v.set(Math.cos(a) * r, 0.12, Math.sin(a) * r);
      q.setFromEuler(e.set((rand() - 0.5) * 0.4, rand() * 3, (rand() - 0.5) * 0.4));
      s.setScalar(0.7 + rand() * 0.8);
      tufts.setMatrixAt(i, m4.compose(v, q, s));
      tufts.setColorAt(i, new THREE.Color().setHSL(0.3 + rand() * 0.06, 0.45, 0.32 + rand() * 0.1));
    }
    this.scene.add(tufts);

    // A tree and lanterns behind the cats
    const tree = new THREE.Group();
    tree.add(new THREE.Mesh(paint(new THREE.CylinderGeometry(0.18, 0.28, 2, 6).translate(0, 1, 0), () => new THREE.Color('#5a4038')), mat));
    const leaf = ['#2f6f68', '#3b8174', '#2a5f5e'].map((c) => new THREE.Color(c));
    [[0, 2.4, 0, 1.3], [0.7, 2.0, 0.2, 0.9], [-0.6, 2.1, -0.2, 0.95], [0.1, 3.1, 0, 0.9]].forEach(([x, y, z, r], i) => {
      tree.add(new THREE.Mesh(paint(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z), () => leaf[i % 3]), mat));
    });
    tree.position.set(-3.2, 0, -2.6);
    tree.traverse((o) => { o.castShadow = true; });
    this.scene.add(tree);

    const lanternMat = new THREE.MeshStandardMaterial({ color: '#ffcf7a', emissive: '#ffb347', emissiveIntensity: 2 });
    const postMat = new THREE.MeshStandardMaterial({ color: '#3b3346', flatShading: true });
    for (const x of [-3.4, 3.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.6, 5).translate(0, 0.8, 0), postMat);
      post.position.set(x, 0, 0.8);
      const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), lanternMat);
      lamp.position.set(x, 1.75, 0.8);
      const light = new THREE.PointLight('#ffb357', 5, 6, 1.5);
      light.position.copy(lamp.position);
      this.scene.add(post, lamp, light);
    }

    // Moon + glow
    const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(9, 2), new THREE.MeshBasicMaterial({ color: '#fff3d6', fog: false }));
    moon.position.set(-45, 60, -120);
    this.scene.add(moon);
    const gc = document.createElement('canvas');
    gc.width = gc.height = 256;
    const g = gc.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,240,210,0.7)');
    grad.addColorStop(0.3, 'rgba(200,180,255,0.25)');
    grad.addColorStop(1, 'rgba(120,100,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const glowTex = new THREE.CanvasTexture(gc);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    this.moonGlow = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.moonGlow.position.copy(moon.position).multiplyScalar(1.02);
    this.scene.add(this.moonGlow);

    // Stars
    const stars = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.35, 0), new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false }), 500);
    for (let i = 0; i < 500; i++) {
      const a = rand() * Math.PI * 2, y = 0.05 + rand() * 0.95;
      const r = Math.sqrt(1 - y * y);
      v.set(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(200);
      s.setScalar(0.4 + rand() * 1.2);
      stars.setMatrixAt(i, m4.compose(v, q.identity(), s));
    }
    this.scene.add(stars);

    // Fireflies
    this.fireflies = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.04, 0), new THREE.MeshBasicMaterial({ color: '#ffe48a' }), 36);
    this.fireflySeeds = Array.from({ length: 36 }, () => [rand() * 6.28, 1.5 + rand() * 5, 0.3 + rand() * 2, 0.2 + rand() * 0.5]);
    this.fireflies.frustumCulled = false;
    this.scene.add(this.fireflies);
    this._m4 = m4;
    this._v = v;
    this._q = q;
    this._s = s;
  }

  buildCats() {
    const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });
    const stone = ['#8f88a8', '#7d7696', '#9a93b3'].map((c) => new THREE.Color(c));
    const silhouette = new THREE.MeshStandardMaterial({ color: '#07060d', emissive: '#1d1640', emissiveIntensity: 0.6, roughness: 1, flatShading: true });
    this.cats = HEROES.map((hero, i) => {
      const x = (i - (HEROES.length - 1) / 2) * 2.2;
      const ped = new THREE.Mesh(paint(new THREE.CylinderGeometry(0.62, 0.72, 0.35, 8).translate(0, 0.175, 0), (p) => stone[(Math.abs(p.x * 5 + p.z * 3) | 0) % 3]), stoneMat);
      ped.position.set(x, 0, 0);
      ped.castShadow = ped.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.025, 4, 32), new THREE.MeshBasicMaterial({ color: hero.accent, transparent: true }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, 0.36, 0);
      const cat = new Cat(hero);
      cat.root.position.set(x, 0.35, 0);
      if (hero.locked) {
        // locked heroes are a dark silhouette until unlocked
        cat.root.traverse((o) => {
          if (o.isMesh) o.material = silhouette;
        });
        ring.material.color.set('#6a6488');
      }
      this.scene.add(ped, ring, cat.root);
      return { hero, cat, ring, x, y: 0, vy: 0, scale: 1, yaw: 0, shake: 0 };
    });
  }

  buildUI() {
    this.logo = new TextPanel(1024, 400, 2.3, (ctx, w, h) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // crescent moon
      ctx.save();
      ctx.shadowColor = 'rgba(255,230,160,0.9)';
      ctx.shadowBlur = 30;
      ctx.fillStyle = '#ffe9b0';
      ctx.beginPath();
      ctx.arc(w / 2, 62, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(w / 2 + 18, 50, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.font = `700 210px ${FONT}`;
      const grad = ctx.createLinearGradient(0, 110, 0, 300);
      grad.addColorStop(0, '#fff7e0');
      grad.addColorStop(1, '#ffbf5a');
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(150,120,255,0.95)';
      ctx.shadowBlur = 50;
      ctx.lineWidth = 18;
      ctx.strokeStyle = '#2a1c4f';
      ctx.strokeText('FELUNA', w / 2, 210);
      ctx.shadowBlur = 0;
      ctx.fillStyle = grad;
      ctx.fillText('FELUNA', w / 2, 210);
      ctx.font = `600 40px ${FONT}`;
      ctx.fillStyle = '#d6dcff';
      ctx.fillText('·  a roguelite of nine lives  ·', w / 2, 345);
    });

    this.pressStart = new TextPanel(1024, 110, 1.3, (ctx, w, h, device) => {
      drawPrompts(ctx, [{ pad: 'A', key: 'Enter', label: 'Press to Start', touchLabel: 'Tap to Start' }], w / 2, h / 2, 64, device, '#fff4d8');
    });

    this.header = new TextPanel(1024, 120, 1.3, (ctx, w, h) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 76px ${FONT}`;
      ctx.lineWidth = 12;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#211743';
      ctx.strokeText('Choose Your Hero', w / 2, h / 2);
      ctx.fillStyle = '#fff1d2';
      ctx.fillText('Choose Your Hero', w / 2, h / 2);
    });

    this.card = new TextPanel(1100, 330, 1.75, (ctx, w, h, hero) => {
      if (hero.locked) {
        roundRect(ctx, 6, 6, w - 12, h - 12, 36, 'rgba(22,17,48,0.82)', '#6a6488', 5);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#fff';
        ctx.font = `700 84px ${FONT}`;
        ctx.fillText('🔒 ???', 48, 112);
        ctx.fillStyle = '#b9b2e0';
        ctx.font = `600 36px ${FONT}`;
        ctx.fillText(hero.title, 48, 162);
        ctx.fillStyle = '#cfcbe8';
        ctx.font = `400 30px ${FONT}`;
        wrapText(ctx, hero.blurb, 48, 214, 560, 38);
        ctx.fillStyle = '#ffd36a';
        ctx.font = `600 30px ${FONT}`;
        wrapText(ctx, hero.unlockText, 660, 120, 400, 40);
        return;
      }
      roundRect(ctx, 6, 6, w - 12, h - 12, 36, 'rgba(22,17,48,0.82)', hero.accent, 5);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = `700 84px ${FONT}`;
      ctx.fillText(hero.name, 48, 112);
      ctx.fillStyle = hero.accent;
      ctx.font = `600 36px ${FONT}`;
      ctx.fillText(hero.title, 48, 162);
      ctx.fillStyle = '#cfcbe8';
      ctx.font = `400 30px ${FONT}`;
      wrapText(ctx, hero.blurb, 48, 214, 560, 38);
      const bars = Object.entries(hero.bars);
      bars.forEach(([k, v], i) => {
        const y = 78 + i * 62;
        ctx.fillStyle = '#e9e5ff';
        ctx.font = `600 32px ${FONT}`;
        ctx.fillText(k, 660, y + 12);
        for (let j = 0; j < 5; j++) {
          roundRect(ctx, 840 + j * 44, y - 10, 36, 28, 8, j < v ? hero.accent : 'rgba(255,255,255,0.12)');
        }
      });
    });

    this.prompts = new TextPanel(1400, 90, 1.7, (ctx, w, h, device) => {
      if (device === 'touch') {
        drawPrompts(ctx, [{ label: 'Tap a cat to choose' }, { label: 'Tap again to play' }], w / 2, h / 2, 54, device);
        return;
      }
      drawPrompts(ctx, [
        { pad: 'DPAD_LR', key: '← →', label: 'Choose' },
        { pad: 'A', key: 'Enter', label: 'Select' },
        { pad: 'B', key: 'Esc', label: 'Back' },
      ], w / 2, h / 2, 54, device);
    });

    this.levelPanel = new TextPanel(1100, 300, 1.75, (ctx, w, h, idx, hero) => {
      roundRect(ctx, 6, 6, w - 12, h - 12, 36, 'rgba(22,17,48,0.86)', hero.accent, 5);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#b9b2e0';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText(`${hero.name} · Start at`, w / 2, 56);
      ctx.fillStyle = '#fff';
      ctx.font = `700 76px ${FONT}`;
      ctx.fillText(`◀   Level ${idx + 1}   ▶`, w / 2, 136);
      ctx.fillStyle = hero.accent;
      ctx.font = `600 40px ${FONT}`;
      ctx.fillText(LEVELS[idx].name, w / 2, 202);
      ctx.fillStyle = '#9f9ac4';
      ctx.font = `400 26px ${FONT}`;
      ctx.fillText(idx === 0 ? 'A fresh run' : 'With the upgrades and bird friends you had when you got there', w / 2, 254);
    });
    this.levelPrompts = new TextPanel(1400, 90, 1.7, (ctx, w, h, device) => {
      if (device === 'touch') {
        drawPrompts(ctx, [{ label: 'Tap the sides to change level' }, { label: 'Tap the middle to play' }], w / 2, h / 2, 54, device);
        return;
      }
      drawPrompts(ctx, [
        { pad: 'DPAD_LR', key: '← →', label: 'Level' },
        { pad: 'A', key: 'Enter', label: 'Play' },
        { pad: 'B', key: 'Esc', label: 'Back' },
      ], w / 2, h / 2, 54, device);
    });

    this.labels = this.cats.map((c) => {
      const p = new TextPanel(512, 110, 0.85, (ctx, w, h) => {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `700 70px ${FONT}`;
        ctx.lineWidth = 10;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1b1338';
        const label = c.hero.locked ? '???' : c.hero.name;
        ctx.strokeText(label, w / 2, h / 2);
        ctx.fillStyle = c.hero.locked ? '#9a94c0' : c.hero.accent;
        ctx.fillText(label, w / 2, h / 2);
      });
      p.redraw();
      p.mesh.position.set(c.x, 1.75, 0);
      this.scene.add(p.mesh);
      return p;
    });

    this.hud = [this.logo, this.pressStart, this.header, this.card, this.prompts, this.levelPanel, this.levelPrompts];
    for (const p of this.hud) this.camera.add(p.mesh);
    this.logo.redraw();
    this.header.redraw();
    this.redrawUI();
  }

  redrawUI() {
    const d = this.input.device;
    this.pressStart.redraw(d);
    this.prompts.redraw(d);
    this.levelPrompts.redraw(d);
    this.card.redraw(HEROES[this.sel ?? 0]);
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  layoutUI() {
    const { w, h } = frustumHalf(this.camera, HUD_DIST);
    const fit = (p, frac) => Math.min(1, (w * 2 * frac) / p.worldW);
    const place = (p, y, s) => {
      p.mesh.scale.setScalar(s);
      p.mesh.position.set(0, y, -HUD_DIST);
    };
    const ls = fit(this.logo, 0.9);
    place(this.logo, h - (this.logo.worldH * ls) / 2 - h * 0.08, ls);
    place(this.pressStart, -h * 0.72, fit(this.pressStart, 0.9));
    const hs = fit(this.header, 0.9);
    place(this.header, h - (this.header.worldH * hs) / 2 - h * 0.05, hs);
    const ps = fit(this.prompts, 0.95);
    const py = -h + (this.prompts.worldH * ps) / 2 + h * 0.03;
    place(this.prompts, py, ps);
    place(this.levelPrompts, py, ps);
    const cs = fit(this.card, 0.92);
    place(this.card, py + (this.prompts.worldH * ps) / 2 + (this.card.worldH * cs) / 2 + h * 0.02, cs);
    place(this.levelPanel, py + (this.prompts.worldH * ps) / 2 + (this.levelPanel.worldH * cs) / 2 + h * 0.02, cs);
  }

  begin(level) {
    this.starting = true;
    this.startTimer = 0.75;
    this.startLevel = level;
    this.cats[this.sel].vy = 4.5;
  }

  setSel(i) {
    if (i === this.sel) return;
    this.sel = i;
    this.card.redraw(HEROES[i]);
    const c = this.cats[i];
    if (c.y <= 0) c.vy = 3.2;
  }

  update(dt, locked) {
    this.t += dt;
    const s = this.input.state;
    const t = this.t;

    if (!locked && !this.starting && s.tap) {
      if (this.state === 'title') {
        s.confirm = true;
        requestFullscreenLandscape();
      } else if (this.state === 'select') {
        // tap a cat to select it; tap the selected cat (or the card) to start
        const idx = Math.min(HEROES.length - 1, Math.floor(s.tap.x * HEROES.length));
        if (s.tap.y > 0.62 || idx === this.sel) s.confirm = true;
        else this.setSel(idx);
      } else if (this.state === 'levels') {
        if (s.tap.x < 0.3) s.left = true;
        else if (s.tap.x > 0.7) s.right = true;
        else s.confirm = true;
      }
    }
    if (!locked && !this.starting) {
      if (this.state === 'title') {
        if (s.confirm) {
          this.state = 'select';
          this.sel = -1;
          this.setSel(0);
        }
      } else if (this.state === 'select') {
        if (s.left) this.setSel((this.sel + HEROES.length - 1) % HEROES.length);
        if (s.right) this.setSel((this.sel + 1) % HEROES.length);
        if (s.back) this.state = 'title';
        else if (s.confirm) {
          const hero = HEROES[this.sel];
          const c = this.cats[this.sel];
          if (hero.locked) {
            c.shake = 0.5; // not yet!
          } else if (Save.best(hero.id) > 0) {
            // pick a starting level
            this.state = 'levels';
            this.levelSel = Save.best(hero.id);
            this.levelPanel.redraw(this.levelSel, hero);
            c.vy = 3;
          } else this.begin(0);
        }
      } else if (this.state === 'levels') {
        const hero = HEROES[this.sel];
        const max = Save.best(hero.id);
        if (s.left || s.right) {
          this.levelSel = (this.levelSel + (s.right ? 1 : max)) % (max + 1);
          this.levelPanel.redraw(this.levelSel, hero);
        }
        if (s.back) this.state = 'select';
        else if (s.confirm) this.begin(this.levelSel);
      }
    }
    if (this.starting) {
      this.startTimer -= dt;
      if (this.startTimer <= 0 && this.starting !== 'done') {
        this.starting = 'done';
        this.onStart(HEROES[this.sel], this.startLevel);
      }
    }

    // Camera
    const levels = this.state === 'levels';
    const sel = this.state === 'select' || levels;
    let tp, tl;
    if (sel) {
      const base = 3.2 + HEROES.length * 0.85;
      const back = this.camera.aspect < 1.3 ? base * Math.min(1.8, 1.3 / Math.max(0.5, this.camera.aspect)) : base;
      tp = this._tp ??= new THREE.Vector3();
      tl = this._tl ??= new THREE.Vector3();
      tp.set(0, 1.5, back);
      tl.set(0, 0.6, 0);
    } else {
      const a = Math.sin(t * 0.12) * 0.55;
      tp = (this._tp ??= new THREE.Vector3()).set(Math.sin(a) * 10, 3.2, Math.cos(a) * 10);
      tl = (this._tl ??= new THREE.Vector3()).set(0, 2.5, 0);
    }
    const k = 2.5;
    this.camPos.x = damp(this.camPos.x, tp.x, k, dt);
    this.camPos.y = damp(this.camPos.y, tp.y, k, dt);
    this.camPos.z = damp(this.camPos.z, tp.z, k, dt);
    this.camLook.x = damp(this.camLook.x, tl.x, k, dt);
    this.camLook.y = damp(this.camLook.y, tl.y, k, dt);
    this.camLook.z = damp(this.camLook.z, tl.z, k, dt);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.sky.position.copy(this.camera.position);
    this.moonGlow.lookAt(this.camera.position);

    // UI fades
    const fadeK = 6;
    this.logo.opacity = damp(this.logo.opacity, sel ? 0 : 1, fadeK, dt);
    this.pressBase = damp(this.pressBase ?? 0, sel ? 0 : 1, fadeK, dt);
    this.pressStart.opacity = this.pressBase * (0.6 + 0.4 * Math.sin(t * 3.5));
    for (const p of [this.header, this.card, this.prompts]) p.opacity = damp(p.opacity, sel && !levels && !this.starting ? 1 : 0, fadeK, dt);
    for (const p of [this.levelPanel, this.levelPrompts]) p.opacity = damp(p.opacity, levels && !this.starting ? 1 : 0, fadeK, dt);
    this.layoutUI();

    // Cats
    this.cats.forEach((c, i) => {
      const chosen = sel && i === this.sel;
      c.vy -= 14 * dt;
      c.y += c.vy * dt;
      if (c.y <= 0) {
        if (c.vy < -1.5) c.cat.land(Math.min(1, -c.vy / 6));
        c.y = 0;
        c.vy = 0;
      }
      c.scale = damp(c.scale, sel && !chosen ? 0.88 : 1, 6, dt);
      c.yaw = damp(c.yaw, sel && !chosen ? -Math.sign(c.x) * 0.45 : 0, 5, dt);
      c.shake = Math.max(0, c.shake - dt);
      c.cat.root.position.x = c.x + Math.sin(c.shake * 60) * c.shake * 0.25;
      c.cat.root.position.y = 0.35 + c.y;
      c.cat.root.scale.setScalar(c.scale);
      c.cat.root.rotation.y = c.yaw;
      c.cat.update(dt, { grounded: c.y <= 0, vy: c.vy, excited: chosen });
      c.ring.material.opacity = damp(c.ring.material.opacity, chosen ? 0.6 + 0.4 * Math.sin(t * 4) : 0.15, 8, dt);
      this.labels[i].opacity = damp(this.labels[i].opacity, sel && !this.starting ? (chosen ? 1 : 0.45) : 0, fadeK, dt);
      this.labels[i].mesh.quaternion.copy(this.camera.quaternion);
      this.labels[i].mesh.position.y = 1.7 + c.y * 0.3 + (chosen ? Math.sin(t * 3) * 0.03 : 0);
    });
    const target = sel ? this.cats[this.sel].x : 0;
    this.spot.target.position.x = damp(this.spot.target.position.x, target, 8, dt);
    this.spot.position.x = this.spot.target.position.x;
    this.spot.intensity = damp(this.spot.intensity, sel ? 30 : 8, 4, dt);

    // Fireflies
    const { _m4: m4, _v: v, _q: q, _s: sc } = this;
    this.fireflySeeds.forEach(([a, r, h, sp], i) => {
      const ang = a + t * sp * 0.3;
      v.set(Math.cos(ang) * r, h + Math.sin(t * sp * 2 + a) * 0.3, Math.sin(ang) * r);
      sc.setScalar(0.6 + 0.6 * Math.max(0, Math.sin(t * 3 * sp + a * 5)));
      this.fireflies.setMatrixAt(i, m4.compose(v, q.identity(), sc));
    });
    this.fireflies.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    disposeTree(this.scene);
  }
}
