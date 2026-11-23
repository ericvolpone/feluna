import * as THREE from 'three/webgpu';

export const FONT = `'Fredoka', 'Trebuchet MS', 'Segoe UI', sans-serif`;

export async function loadFonts() {
  try {
    await Promise.race([
      Promise.all(['700 64px Fredoka', '600 32px Fredoka', '400 32px Fredoka'].map((f) => document.fonts.load(f))),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* fall back to system fonts */ }
}

/**
 * A quad textured with a 2D canvas, rendered by the GPU like any other mesh.
 * This is how all menu text lives inside the WebGPU scene instead of the DOM.
 */
export class TextPanel {
  constructor(cw, ch, worldW, draw) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx = this.canvas.getContext('2d');
    this.drawFn = draw;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false,
    });
    this.worldW = worldW;
    this.worldH = (worldW * ch) / cw;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.worldW, this.worldH), this.mat);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.alpha = 0;
    this.opacity = 0;
  }

  redraw(...args) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawFn(ctx, canvas.width, canvas.height, ...args);
    this.tex.needsUpdate = true;
  }

  set opacity(v) {
    this.alpha = v;
    this.mat.opacity = v;
    this.mesh.visible = v > 0.004;
  }

  get opacity() {
    return this.alpha;
  }
}

/** Visible half-extents of a camera's frustum at distance d. */
export function frustumHalf(camera, d) {
  const h = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return { w: h * camera.aspect, h };
}

const PAD_COLORS = { A: '#4fc46a', B: '#e8545a', X: '#4d93f0', Y: '#f2c43c' };

/** Draws a controller button or keyboard key glyph; returns its width. */
export function drawGlyph(ctx, x, y, size, item, device) {
  if (device === 'touch' && !item.touch) return 0;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let w;
  if (device === 'gamepad' && item.pad === 'DPAD_LR') {
    w = size * 1.7;
    roundRect(ctx, x, y - size / 2, w, size, size * 0.3, '#2a2548', '#d9d4ff');
    ctx.fillStyle = '#f4f1ff';
    tri(ctx, x + w * 0.27, y, size * 0.22, -1);
    tri(ctx, x + w * 0.73, y, size * 0.22, 1);
  } else if (device === 'gamepad' && PAD_COLORS[item.pad]) {
    w = size;
    ctx.beginPath();
    ctx.arc(x + size / 2, y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = PAD_COLORS[item.pad];
    ctx.fill();
    ctx.lineWidth = size * 0.07;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${size * 0.6}px ${FONT}`;
    ctx.fillText(item.pad, x + size / 2, y + size * 0.03);
  } else {
    const label = device === 'gamepad' ? item.pad : device === 'touch' ? item.touch : item.key;
    ctx.font = `600 ${size * 0.5}px ${FONT}`;
    w = Math.max(size, ctx.measureText(label).width + size * 0.6);
    roundRect(ctx, x, y - size / 2, w, size, size * 0.22, '#f2efff', '#8b84c9');
    ctx.fillStyle = '#2a2548';
    ctx.fillText(label, x + w / 2, y + size * 0.03);
  }
  ctx.restore();
  return w;
}

/** Lays out a centered row of [glyph label] prompts. */
export function drawPrompts(ctx, items, cx, cy, size, device, color = '#eae6ff') {
  ctx.save();
  ctx.font = `600 ${size * 0.62}px ${FONT}`;
  const gap = size * 0.3, spacing = size * 1.1;
  const label = (it) => (device === 'touch' && it.touchLabel) || it.label;
  const widths = items.map((it) => {
    const g = measureGlyph(ctx, size, it, device);
    return g + (g ? gap : 0) + ctx.measureText(label(it)).width;
  });
  let x = cx - (widths.reduce((a, b) => a + b, 0) + spacing * (items.length - 1)) / 2;
  items.forEach((it, i) => {
    const gw = drawGlyph(ctx, x, cy, size, it, device);
    ctx.font = `600 ${size * 0.62}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8;
    ctx.fillText(label(it), x + gw + (gw ? gap : 0), cy + size * 0.03);
    ctx.shadowBlur = 0;
    x += widths[i] + spacing;
  });
  ctx.restore();
}

function measureGlyph(ctx, size, item, device) {
  if (device === 'touch' && !item.touch) return 0;
  if (device === 'gamepad' && item.pad === 'DPAD_LR') return size * 1.7;
  if (device === 'gamepad' && PAD_COLORS[item.pad]) return size;
  ctx.save();
  ctx.font = `600 ${size * 0.5}px ${FONT}`;
  const w = Math.max(size, ctx.measureText(device === 'gamepad' ? item.pad : device === 'touch' ? item.touch : item.key).width + size * 0.6);
  ctx.restore();
  return w;
}

export function roundRect(ctx, x, y, w, h, r, fill, stroke, lw = 3) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function tri(ctx, x, y, r, dir) {
  ctx.beginPath();
  ctx.moveTo(x + dir * r, y);
  ctx.lineTo(x - dir * r * 0.7, y - r);
  ctx.lineTo(x - dir * r * 0.7, y + r);
  ctx.closePath();
  ctx.fill();
}

export function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w;
      y += lineH;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, y);
}
