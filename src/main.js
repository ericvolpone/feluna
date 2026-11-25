import * as THREE from 'three/webgpu';
import { Input } from './input.js';
import { MenuScene } from './menu.js';
import { GameScene, newRun, runFrom } from './game.js';
import { Save } from './save.js';
import { loadFonts } from './ui3d.js';
import { playMusic, onAudioState, audioReady } from './audio.js';
import { IS_TOUCH, LITE } from './device.js';
import { setupMobile } from './mobile.js';

document.body.classList.toggle('touch', IS_TOUCH);

const loading = document.getElementById('loading');

// WebGPURenderer uses WebGPU where available and transparently falls back to WebGL2.
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, LITE ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);

await Promise.all([renderer.init(), loadFonts()]);
document.getElementById('backend').textContent = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (fallback)';

const input = new Input(renderer.domElement);
const fade = document.getElementById('fade');
const fadeTo = (v) => new Promise((r) => {
  fade.style.opacity = v;
  setTimeout(r, 420);
});

let busy = false;
async function transition(fn) {
  if (busy) return;
  busy = true;
  await fadeTo(1);
  await fn();
  await fadeTo(0);
  busy = false;
}

let game = null;
let run = null;

/** Build the level for run.level and swap it in (called inside a fade). */
async function loadLevel() {
  game?.dispose();
  Save.levelStarted(run);
  game = new GameScene(input, run, renderer.domElement, {
    onQuit: () => transition(quitGame),
    onNext: () => transition(() => {
      run.level++;
      return loadLevel();
    }),
    onRetry: (kind) => transition(() => {
      run = runFrom(run.hero, kind === 'victory' ? 0 : run.level);
      return loadLevel();
    }),
  });
  resize();
  await renderer.compileAsync(game.scene, game.camera);
  active = game;
}

const menu = new MenuScene(input, {
  onStart: (hero, level = 0) => transition(() => {
    run = runFrom(hero, level);
    return loadLevel();
  }),
});
let active = menu;
playMusic('title');

function quitGame() {
  game.dispose();
  game = null;
  run = null;
  menu.reset();
  menu.redrawUI();
  active = menu;
  playMusic('title');
}

// Sound needs one click/keypress (controller buttons don't count in browsers)
const soundHint = document.getElementById('sound-hint');
if (IS_TOUCH) soundHint.textContent = '🔈 Tap to turn on sound';
soundHint.classList.toggle('hidden', audioReady());
onAudioState((ok) => soundHint.classList.toggle('hidden', ok));

function resize() {
  if (!innerWidth || !innerHeight) return;
  renderer.setSize(innerWidth, innerHeight);
  const aspect = innerWidth / innerHeight;
  menu.resize(aspect);
  game?.resize(aspect);
}
addEventListener('resize', resize);
// iOS Safari's toolbars change the visible area without always firing window resize
window.visualViewport?.addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 300));
setupMobile();
resize();

await renderer.compileAsync(menu.scene, menu.camera);
loading.remove();
fadeTo(0);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.poll();
  active.update(dt, busy);
  document.body.classList.toggle('ingame', active === game);
  if (!innerWidth || !innerHeight) return; // hidden / zero-size window
  renderer.render(active.scene, active.camera);
});

// handy for debugging from the console
window.feluna = {
  renderer, input, menu,
  get active() { return active; },
  get game() { return game; },
  get run() { return run; },
  save: Save,
  /** Debug: jump straight to a level, e.g. feluna.warp(2) */
  warp: (i, heroIndex = 0) => transition(async () => {
    const { HEROES } = await import('./heroes.js');
    run = newRun(run?.hero ?? HEROES[heroIndex]);
    run.level = i;
    return loadLevel();
  }),
};
