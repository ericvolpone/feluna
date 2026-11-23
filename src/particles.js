import * as THREE from 'three/webgpu';

function tex(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d'), 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function heartPath(g, s, cx, cy) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.32);
  g.bezierCurveTo(cx - s * 0.55, cy - s * 0.05, cx - s * 0.32, cy - s * 0.48, cx, cy - s * 0.2);
  g.bezierCurveTo(cx + s * 0.32, cy - s * 0.48, cx + s * 0.55, cy - s * 0.05, cx, cy + s * 0.32);
  g.closePath();
}

const DRAW = {
  heart: (g, s) => {
    heartPath(g, s, s / 2, s / 2 + 4);
    g.fillStyle = '#ff6f9f';
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = '#ffffff';
    g.stroke();
  },
  note: (g, s) => {
    g.font = `700 ${s * 0.8}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = '#ffffff';
    g.strokeText('♪', s / 2, s / 2);
    g.fillStyle = '#7a5cff';
    g.fillText('♪', s / 2, s / 2);
  },
  sparkle: (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,240,180,0.8)');
    grad.addColorStop(1, 'rgba(255,220,120,0)');
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? c * 0.22 : c;
      const a = (i / 8) * Math.PI * 2;
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.fill();
  },
  slash: (g, s) => {
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(s * 0.1, s * (0.95 + i * 0.12), s * 0.85, -1.25, -0.2);
      g.lineWidth = 8 - i * 2;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.stroke();
    }
  },
  puff: (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(240,235,220,0.9)');
    grad.addColorStop(1, 'rgba(240,235,220,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  },
  feather: (g, s) => {
    g.translate(s / 2, s / 2);
    g.rotate(0.6);
    g.beginPath();
    g.ellipse(0, 0, s * 0.14, s * 0.42, 0, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = '#c9d6ff';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(0, -s * 0.42);
    g.lineTo(0, s * 0.45);
    g.stroke();
  },
};

/** Small pooled billboard particle system (hearts, notes, sparkles, claw slashes...). */
export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.textures = Object.fromEntries(Object.entries(DRAW).map(([k, d]) => [k, tex(d)]));
    this.pool = {};
    this.live = [];
  }

  spawn(type, pos, { vel = null, life = 1, size = 0.4, grow = 0, gravity = 0, spin = 0, additive = false } = {}) {
    const pool = (this.pool[type] ??= []);
    let p = pool.pop();
    if (!p) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.textures[type], transparent: true, depthWrite: false, fog: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      p = { mesh: new THREE.Mesh(this.geo, mat), vel: new THREE.Vector3(), type };
      p.mesh.renderOrder = 10;
      p.mesh.frustumCulled = false;
    }
    p.mesh.position.copy(pos);
    p.vel.copy(vel ?? new THREE.Vector3(0, 1, 0));
    Object.assign(p, { life, max: life, size, grow, gravity, spin, rot: Math.random() * (spin ? 6 : 0) });
    this.scene.add(p.mesh);
    this.live.push(p);
    return p;
  }

  burst(type, pos, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed ?? 2) * (0.5 + Math.random() * 0.7);
      this.spawn(type, pos, {
        ...opts,
        vel: new THREE.Vector3(Math.cos(a) * sp, (opts.up ?? 2) * (0.6 + Math.random() * 0.8), Math.sin(a) * sp),
        life: (opts.life ?? 1) * (0.7 + Math.random() * 0.6),
      });
    }
  }

  update(dt, camera) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.pool[p.type].push(p);
        this.live.splice(i, 1);
        continue;
      }
      const u = 1 - p.life / p.max;
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.exp(-1.5 * dt));
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.quaternion.copy(camera.quaternion);
      p.rot += p.spin * dt;
      p.mesh.rotateZ(p.rot);
      const pop = Math.min(1, u * 8);
      p.mesh.scale.setScalar(p.size * (0.4 + 0.6 * pop) * (1 + p.grow * u));
      p.mesh.material.opacity = Math.min(1, p.life / (p.max * 0.35));
    }
  }

  dispose() {
    for (const p of this.live) this.scene.remove(p.mesh);
    for (const t of Object.values(this.textures)) t.dispose();
  }
}
