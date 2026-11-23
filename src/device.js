// Device capabilities, decided once at startup.
// "Touch" means the primary pointer is a finger (phones, tablets) — a touchscreen
// laptop with a trackpad still counts as a regular desktop.
const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;

export const IS_TOUCH = mq('(pointer: coarse)') || (navigator.maxTouchPoints > 1 && mq('(hover: none)'));

/** Lighter rendering for phones/tablets: lower resolution, smaller shadows, less grass. */
export const LITE = IS_TOUCH;
