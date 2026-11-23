// In-game overlay (DOM). The title/select screens are fully in-canvas; the gameplay
// HUD stays in the DOM for crisp text at any resolution.
const $ = (id) => document.getElementById(id);

const HINTS = {
  keyboard: [['WASD', 'Move'], ['Mouse', 'Look'], ['Space', 'Jump'], ['Shift', 'Sprint'], ['E / Click', 'Claws'], ['F', 'Meow'], ['Esc', 'Pause']],
  gamepad: [['L-Stick', 'Move'], ['R-Stick', 'Look'], ['A', 'Jump'], ['LT', 'Sprint'], ['RT', 'Claws'], ['X', 'Meow'], ['Start', 'Pause']],
  touch: [],
};
const GLYPHS = {
  keyboard: { claw: 'E', meow: 'F', jump: 'Space', move: 'S', confirm: 'Enter', nav: '← →' },
  gamepad: { claw: 'RT', meow: 'X', jump: 'A', move: 'L-Stick', confirm: 'A', nav: 'D-pad' },
  touch: { claw: 'Claws', meow: 'Meow', jump: 'Jump', move: 'Stick', confirm: 'Tap', nav: 'Tap' },
};
const PAD_CLASS = { A: 'pad-a', X: 'pad-x', B: 'pad-b', Y: 'pad-y' };

export class Hud {
  constructor() {
    this.root = $('hud');
    this.pause = $('pause');
    this.device = 'keyboard';
    this.context = null;
  }

  show(hero, levelName) {
    this.root.classList.remove('hidden');
    $('hud-hero').textContent = hero.name;
    $('hud-hero').style.borderColor = hero.accent;
    $('hud-level').textContent = levelName;
    this.showChoice(null);
    $('end').classList.add('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
    this.pause.classList.add('hidden');
    $('choice').classList.add('hidden');
    $('end').classList.add('hidden');
  }

  setHearts(h, max) {
    let html = '';
    for (let i = 0; i < max; i++) html += `<span class="${i < h ? 'full' : 'empty'}">♥</span>`;
    const el = $('hud-hearts');
    if (el.dataset.h && +el.dataset.h > h) {
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
    }
    el.dataset.h = h;
    el.innerHTML = html;
  }

  setStats({ moon, moonTotal, tuna, tunaNeed, friends, perks }) {
    $('hud-stones').innerHTML = `<span class="gem">◆</span> ${moon} / ${moonTotal}`;
    $('hud-tuna').innerHTML = `<span class="fish">🐟</span><span class="bar"><i style="width:${(tuna / tunaNeed) * 100}%"></i></span>${tuna}/${tunaNeed}`;
    $('hud-friends').innerHTML = `<span class="bird">🐦</span> ${friends}${perks.length ? ` <small>${perks.join(' · ')}</small>` : ''}`;
  }

  setDevice(device) {
    this.device = device;
    $('hud-hint').innerHTML = HINTS[device].map(([k, v]) => `<span>${this.key(k)}${v}</span>`).join('');
    $('pause-hint').textContent = device === 'gamepad' ? 'D-pad to choose · A select · B resume' : device === 'touch' ? '' : '↑↓ to choose · Enter select · Esc resume';
    this.setContext(this.context);
  }

  key(label) {
    const cls = this.device === 'gamepad' && PAD_CLASS[label] ? ` class="${PAD_CLASS[label]}"` : '';
    return `<kbd${cls}>${label}</kbd>`;
  }

  /** Contextual action prompt, e.g. [['claw', 'Claws to climb']]. */
  setContext(items) {
    this.context = items;
    const el = $('hud-context');
    if (!items) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = items.map(([a, text]) => `<span${a === 'none' ? ' class="plain"' : ''}>${a === 'none' ? '' : this.key(GLYPHS[this.device][a])}${text}</span>`).join('');
    el.classList.remove('hidden');
  }

  toast(msg) {
    const t = $('hud-toast');
    t.textContent = msg;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }

  banner(small, big) {
    const b = $('hud-banner');
    b.innerHTML = `<small>${small}</small>${big}`;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  showPause(on, sel = 0) {
    this.pause.classList.toggle('hidden', !on);
    this.pause.querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', i === sel));
  }

  /** Powerup picker. Pass reason=null to hide. */
  showChoice(reason, items, run, sel = 0) {
    const el = $('choice');
    if (!reason) {
      el.classList.add('hidden');
      return;
    }
    const lv = { speed: run.speedLv, jump: run.jumpLv, heart: run.maxHearts - 3 };
    $('choice-reason').textContent = reason;
    $('choice-cards').innerHTML = items.map((it, i) => `
      <button data-i="${i}" class="card ${i === sel ? 'sel' : ''}">
        <div class="icon">${it.icon}</div>
        <div class="name">${it.name}</div>
        <div class="desc">${it.desc}</div>
        <div class="lv">${'★'.repeat(lv[it.id])}${lv[it.id] ? '' : 'New'}</div>
      </button>`).join('');
    $('choice-hint').innerHTML = this.device === 'touch' ? 'Tap a power to take it' : `${this.key(GLYPHS[this.device].nav)}Choose ${this.key(GLYPHS[this.device].confirm)}Take it`;
    el.classList.remove('hidden');
  }

  showEnd(kind, st, sel = 0) {
    const el = $('end');
    el.classList.toggle('victory', kind === 'victory');
    $('end-title').textContent = kind === 'victory' ? 'The moon shines again!' : 'Out of hearts!';
    $('end-sub').textContent = kind === 'victory'
      ? `You crossed all ${st.level} lands. What a cat.`
      : `You reached level ${st.level}: ${st.levelName}`;
    $('end-stats').innerHTML = `
      <div><b>◆ ${st.moon}</b>moonstones</div>
      <div><b>🐟 ${st.tuna}</b>tuna</div>
      <div><b>🐦 ${st.friends}</b>friends</div>
      <div><b>⏱ ${st.time}</b>time</div>`;
    el.querySelectorAll('button')[0].textContent = kind === 'victory' ? 'Play Again' : 'Try Again';
    this.selectEnd(sel);
    el.classList.remove('hidden');
  }

  selectEnd(sel) {
    $('end').querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', i === sel));
  }
}
