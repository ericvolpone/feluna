/**
 * Unified input: keyboard + mouse and the Gamepad API (standard mapping:
 * Xbox / PlayStation / Switch Pro controllers in Chrome, Edge, Firefox and Safari).
 *
 * Call poll() once per frame; read `state`. Edge-triggered fields (`*Pressed`,
 * confirm/back/left/right/up/down/pause) are true for exactly one frame.
 */
import { TouchControls } from './touch.js';
import { IS_TOUCH } from './device.js';

const DEAD = 0.18;
const TOUCH_LOOK = 2.4; // touch-drag pixels feel smaller than mouse pixels

function stick(x = 0, y = 0) {
  const m = Math.hypot(x, y);
  if (m < DEAD) return { x: 0, y: 0, m: 0 };
  const s = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return { x: x * s, y: y * s, m: Math.min(1, m) };
}

const curve = (v) => v * Math.abs(v);

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  constructor(el) {
    this.el = el;
    this.down = new Set();
    this.pressed = new Set();
    this.mdx = 0;
    this.mdy = 0;
    this.prevPad = [];
    this.prevStickX = 0;
    this.prevStickY = 0;
    this.sprintLatch = false;
    this.mouseDown = false;
    this.mousePressed = false;
    this.device = IS_TOUCH ? 'touch' : 'keyboard';
    this.onDeviceChange = null;
    this.touch = new TouchControls();
    this.tap = null;
    this.state = this.blank();

    // Any finger on the screen switches to touch mode; short taps on the canvas
    // drive the in-canvas menus.
    this.touchStarts = new Map();
    addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.lastTouch = performance.now();
      this.setDevice('touch');
      this.touchStarts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), target: e.target });
    }, { capture: true });
    addEventListener('pointerup', (e) => {
      const st = this.touchStarts.get(e.pointerId);
      this.touchStarts.delete(e.pointerId);
      if (!st || st.target !== el) return;
      if (performance.now() - st.t < 350 && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 18) {
        this.tap = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
      }
    }, { capture: true });

    addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      this.setDevice('keyboard');
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === el) {
        this.mdx += e.movementX;
        this.mdy += e.movementY;
        this.setDevice('keyboard');
      }
    });
    addEventListener('mousedown', (e) => {
      // browsers send emulated mouse events right after a tap — ignore those
      if (performance.now() - (this.lastTouch ?? -1e9) < 1000) return;
      this.setDevice('keyboard');
      if (e.button === 0 && document.pointerLockElement === el) {
        this.mouseDown = true;
        this.mousePressed = true;
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
  }

  blank() {
    return {
      move: { x: 0, y: 0 }, look: { x: 0, y: 0 }, mouse: { x: 0, y: 0 },
      jump: false, jumpPressed: false, sprint: false,
      claw: false, clawPressed: false, meowPressed: false,
      confirm: false, back: false, pause: false,
      left: false, right: false, up: false, down: false,
      tap: null, touch: false, lookTouch: false,
    };
  }

  setDevice(d) {
    if (d !== this.device) {
      this.device = d;
      this.onDeviceChange?.(d);
    }
  }

  getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  poll() {
    const s = this.blank();
    const k = (c) => this.down.has(c);
    const p = (c) => this.pressed.has(c);

    // Keyboard + mouse
    s.move.x = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    s.move.y = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    s.mouse.x = this.mdx;
    s.mouse.y = this.mdy;
    s.jump = k('Space');
    s.jumpPressed = p('Space');
    s.sprint = k('ShiftLeft') || k('ShiftRight');
    s.claw = k('KeyE') || this.mouseDown;
    s.clawPressed = p('KeyE') || this.mousePressed;
    s.meowPressed = p('KeyF');
    s.confirm = p('Enter') || p('NumpadEnter') || p('Space');
    s.back = p('Escape') || p('Backspace');
    s.pause = p('Escape') || p('KeyP');
    s.left = p('ArrowLeft') || p('KeyA');
    s.right = p('ArrowRight') || p('KeyD');
    s.up = p('ArrowUp') || p('KeyW');
    s.down = p('ArrowDown') || p('KeyS');

    // Gamepad
    const pad = this.getPad();
    if (pad) {
      const b = (i) => !!pad.buttons[i]?.pressed;
      const bp = (i) => b(i) && !this.prevPad[i];
      const val = (i) => pad.buttons[i]?.value ?? 0;
      const L = stick(pad.axes[0], pad.axes[1]);
      const R = stick(pad.axes[2], pad.axes[3]);
      const anyButton = pad.buttons.some((x) => x.pressed);
      if (anyButton || L.m > 0 || R.m > 0) this.setDevice('gamepad');

      let mx = L.x, my = -L.y;
      if (b(12)) my += 1;
      if (b(13)) my -= 1;
      if (b(14)) mx -= 1;
      if (b(15)) mx += 1;
      s.move.x += mx;
      s.move.y += my;
      s.look.x = curve(R.x);
      s.look.y = curve(R.y);

      // Sprint: hold LT / LB, or click L3 to toggle (cancels when you stop)
      if (bp(10)) this.sprintLatch = !this.sprintLatch;
      if (L.m < 0.2 && !b(12) && !b(13) && !b(14) && !b(15)) this.sprintLatch = false;
      s.sprint ||= val(6) > 0.35 || b(4) || this.sprintLatch;

      // Claws: RT (or RB)
      const claw = val(7) > 0.35 || b(5);
      s.claw ||= claw;
      s.clawPressed ||= claw && !this.prevClaw;
      this.prevClaw = claw;
      s.meowPressed ||= bp(2);

      s.jump ||= b(0);
      s.jumpPressed ||= bp(0);
      s.confirm ||= bp(0);
      s.back ||= bp(1);
      s.pause ||= bp(9);

      // Menu navigation from d-pad and left stick (edge-triggered)
      const sx = L.x < -0.55 ? -1 : L.x > 0.55 ? 1 : 0;
      const sy = L.y < -0.55 ? -1 : L.y > 0.55 ? 1 : 0;
      s.left ||= bp(14) || (sx === -1 && this.prevStickX !== -1);
      s.right ||= bp(15) || (sx === 1 && this.prevStickX !== 1);
      s.up ||= bp(12) || (sy === -1 && this.prevStickY !== -1);
      s.down ||= bp(13) || (sy === 1 && this.prevStickY !== 1);
      this.prevStickX = sx;
      this.prevStickY = sy;
      this.prevPad = pad.buttons.map((x) => x.pressed);
    }

    // Touch
    if (this.touch.visible) {
      const t = this.touch.read();
      s.move.x += t.move.x;
      s.move.y += t.move.y;
      s.mouse.x += t.lookDx * TOUCH_LOOK;
      s.mouse.y += t.lookDy * TOUCH_LOOK;
      s.lookTouch = t.looking;
      s.sprint ||= t.sprint;
      s.jump ||= t.jump;
      s.jumpPressed ||= t.jumpPressed;
      s.claw ||= t.claw;
      s.clawPressed ||= t.clawPressed;
      s.meowPressed ||= t.meowPressed;
      s.pause ||= t.pause;
    }
    s.touch = this.device === 'touch';
    s.tap = this.tap;
    this.tap = null;

    const m = Math.hypot(s.move.x, s.move.y);
    if (m > 1) {
      s.move.x /= m;
      s.move.y /= m;
    }

    this.pressed.clear();
    this.mousePressed = false;
    this.mdx = this.mdy = 0;
    this.state = s;
    return s;
  }
}
