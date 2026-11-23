/**
 * On-screen touch controls:
 *  - left half: floating joystick (appears where your thumb lands; drag past the
 *    ring to sprint)
 *  - right half: drag to turn the camera
 *  - buttons: Jump, Claws (hold to climb), Meow, Pause
 *
 * read() returns this frame's state and clears one-frame edges and look deltas.
 */
const STICK_R = 62;
const DEAD = 0.12;

/** Capture the pointer so drags keep working outside the element (ignore failures). */
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch { /* pointer already gone */ }
}

export class TouchControls {
  constructor() {
    this.root = document.getElementById('touch');
    this.knob = this.root.querySelector('.knob');
    this.base = this.root.querySelector('.stick');
    this.stick = null; // { id, ox, oy, x, y }
    this.look = null; // { id, x, y }
    this.lookDx = 0;
    this.lookDy = 0;
    this.buttons = {};
    this.visible = false;

    const left = this.root.querySelector('.zone.left');
    const right = this.root.querySelector('.zone.right');

    left.addEventListener('pointerdown', (e) => {
      if (this.stick) return;
      capture(left, e.pointerId);
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      this.base.style.transform = `translate(${e.clientX - STICK_R}px, ${e.clientY - STICK_R}px)`;
      this.base.classList.add('on');
      this.updateKnob();
    });
    left.addEventListener('pointermove', (e) => {
      if (this.stick?.id !== e.pointerId) return;
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      this.updateKnob();
    });
    const endStick = (e) => {
      if (this.stick?.id !== e.pointerId) return;
      this.stick = null;
      this.base.classList.remove('on', 'sprint');
    };
    left.addEventListener('pointerup', endStick);
    left.addEventListener('pointercancel', endStick);

    right.addEventListener('pointerdown', (e) => {
      if (this.look) return;
      capture(right, e.pointerId);
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    right.addEventListener('pointermove', (e) => {
      if (this.look?.id !== e.pointerId) return;
      this.lookDx += e.clientX - this.look.x;
      this.lookDy += e.clientY - this.look.y;
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    });
    const endLook = (e) => {
      if (this.look?.id === e.pointerId) this.look = null;
    };
    right.addEventListener('pointerup', endLook);
    right.addEventListener('pointercancel', endLook);

    for (const el of this.root.querySelectorAll('[data-btn]')) {
      const name = el.dataset.btn;
      const b = (this.buttons[name] = { held: false, pressed: false, el });
      el.addEventListener('pointerdown', (e) => {
        capture(el, e.pointerId);
        b.held = true;
        b.pressed = true;
        el.classList.add('down');
      });
      const up = () => {
        b.held = false;
        el.classList.remove('down');
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    // no long-press menus / text selection on the controls
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  stickVector() {
    if (!this.stick) return { x: 0, y: 0, sprint: false };
    const dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
    const d = Math.hypot(dx, dy);
    const m = Math.min(1, d / STICK_R);
    if (m < DEAD) return { x: 0, y: 0, sprint: false };
    const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / (d || 1);
    return { x: dx * k, y: -dy * k, sprint: d > STICK_R * 1.15 };
  }

  updateKnob() {
    const dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
    const d = Math.hypot(dx, dy), k = d > STICK_R ? STICK_R / d : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    this.base.classList.toggle('sprint', d > STICK_R * 1.15);
  }

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      this.stick = this.look = null;
      this.base.classList.remove('on', 'sprint');
      for (const b of Object.values(this.buttons)) {
        b.held = b.pressed = false;
        b.el.classList.remove('down');
      }
    }
  }

  read() {
    const st = this.stickVector();
    const B = this.buttons;
    const out = {
      move: { x: st.x, y: st.y },
      sprint: st.sprint,
      lookDx: this.lookDx,
      lookDy: this.lookDy,
      looking: !!this.look,
      jump: B.jump.held, jumpPressed: B.jump.pressed,
      claw: B.claw.held, clawPressed: B.claw.pressed,
      meowPressed: B.meow.pressed,
      pause: B.pause.pressed,
    };
    this.lookDx = this.lookDy = 0;
    for (const b of Object.values(B)) b.pressed = false;
    return out;
  }
}
