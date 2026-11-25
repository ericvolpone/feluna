// Phone-browser fixes and fullscreen support.
//
// iPhone Safari ignores `user-scalable=no`, so two thumbs on screen (stick + camera)
// pinch-zoom the page, double taps zoom, and drags scroll/bounce it. We block those
// gestures ourselves. iPhone Safari also has no fullscreen API for web pages, so
// there the fullscreen button explains "Add to Home Screen" instead: the game then
// opens as a web app with no browser bars (see public/manifest.webmanifest).
import { IS_TOUCH } from './device.js';

const ua = navigator.userAgent;
export const IS_IOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const CAN_FULLSCREEN = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

export const isStandalone = () =>
  navigator.standalone === true || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

/** Whether to offer a fullscreen option at all. */
export const offerFullscreen = () => IS_TOUCH && !isStandalone() && !isFullscreen();

export function enterFullscreen() {
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!req) return false;
    const r = req({ navigationUI: 'hide' });
    r?.then?.(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch?.(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Fullscreen if the browser can; otherwise (iPhone) show the Add to Home Screen steps. */
export function fullscreenAction() {
  if (CAN_FULLSCREEN && enterFullscreen()) return;
  document.getElementById('ios-sheet').classList.remove('hidden');
}

export function setupMobile() {
  // ── stop the page itself from zooming / scrolling under the game ──
  const block = (e) => e.preventDefault();
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
    document.addEventListener(ev, block, { passive: false });
  }
  // Pointer events (which the game uses) still fire when touch defaults are blocked.
  // Overlays keep their taps (buttons) and scrolling (long pause menu).
  const keepsDefault = (e) => e.target.closest?.('.overlay, #fs-btn');
  document.addEventListener('touchstart', (e) => {
    if (!keepsDefault(e)) e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || !e.target.closest?.('.overlay .panel')) e.preventDefault();
  }, { passive: false });

  // ── fullscreen button (menus) + iPhone instructions sheet ──
  const btn = document.getElementById('fs-btn');
  const sheet = document.getElementById('ios-sheet');
  const refresh = () => btn.classList.toggle('hidden', !offerFullscreen());
  btn.textContent = CAN_FULLSCREEN ? '⛶ Fullscreen' : '⛶ Play fullscreen';
  btn.addEventListener('click', () => {
    fullscreenAction();
    setTimeout(refresh, 500);
  });
  sheet.querySelector('button').addEventListener('click', () => sheet.classList.add('hidden'));
  document.addEventListener('fullscreenchange', refresh);
  document.addEventListener('webkitfullscreenchange', refresh);
  refresh();
}
