// Synthesized audio (Web Audio): sound effects + generative ambient music. No files.
// Browsers only allow audio after a user gesture (click / key). Gamepad presses
// don't count as a gesture, so the page shows a "click for sound" hint until then.
let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;
const listeners = new Set();

function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.32;
    musicBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().then(notify);
  else notify();
}
function notify() {
  for (const f of listeners) f(audioReady());
  if (audioReady() && wanted && !current) startMusic(wanted);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'touchend', 'click']) addEventListener(ev, unlock, { capture: true });

export const audioReady = () => !!ctx && ctx.state === 'running';
export const onAudioState = (f) => listeners.add(f);

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(type, freqs, times, peak, dur, when = 0, filter = null, bus = sfxBus, attack = 0.01) {
  if (!audioReady()) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freqs[0], t);
  for (let i = 1; i < freqs.length; i++) o.frequency.exponentialRampToValueAtTime(freqs[i], t + times[i - 1]);
  const g = ctx.createGain();
  env(g, t, attack, peak, dur);
  let node = o;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.value = filter.f;
    f.Q.value = filter.q ?? 1;
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(bus);
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}

function noise(dur, peak, filter, when = 0, sweepTo = null) {
  if (!audioReady()) return;
  const t = ctx.currentTime + when;
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  n.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = filter.type;
  f.Q.value = filter.q ?? 1;
  f.frequency.setValueAtTime(filter.f, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = ctx.createGain();
  env(g, t, 0.005, peak, dur);
  n.connect(f).connect(g).connect(sfxBus);
  n.start(t, Math.random() * 0.5);
  n.stop(t + dur + 0.05);
}

const STEP = {
  grass: () => noise(0.06, 0.12, { type: 'lowpass', f: 700 }),
  snow: () => noise(0.09, 0.14, { type: 'bandpass', f: 2600, q: 0.8 }),
  sand: () => noise(0.08, 0.1, { type: 'bandpass', f: 1300, q: 0.7 }),
  stone: () => {
    noise(0.03, 0.12, { type: 'bandpass', f: 1800, q: 2 });
    tone('sine', [220, 160], [0.04], 0.05, 0.04);
  },
  rock: () => noise(0.05, 0.14, { type: 'bandpass', f: 600, q: 1.5 }),
  wood: () => tone('triangle', [190, 150], [0.05], 0.09, 0.06, 0, { type: 'lowpass', f: 900 }),
};

export const sfx = {
  step(surface = 'grass') {
    (STEP[surface] ?? STEP.grass)();
  },
  meow(pitch = 1) {
    if (!audioReady()) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(380 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(720 * pitch, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(420 * pitch, t + 0.42);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(1900, t + 0.15);
    f.frequency.exponentialRampToValueAtTime(800, t + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.05);
    g.gain.setValueAtTime(0.55, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    o.connect(f).connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + 0.5);
  },
  chirp(pitch = 1) {
    tone('sine', [2400 * pitch, 3600 * pitch], [0.06], 0.12, 0.07);
    tone('sine', [2600 * pitch, 3900 * pitch], [0.05], 0.1, 0.06, 0.1);
  },
  /** A little trilling song when a bird becomes your friend. */
  birdSong(pitch = 1) {
    const notes = [0, 4, 7, 4, 9, 7, 12];
    notes.forEach((n, i) => {
      const f = 1800 * pitch * Math.pow(2, n / 12);
      tone('sine', [f, f * 1.25, f], [0.04, 0.08], 0.1, 0.09, i * 0.1);
    });
    tone('sine', [3000 * pitch, 4200 * pitch, 3200 * pitch], [0.05, 0.15], 0.08, 0.2, 0.75);
  },
  tuna() {
    [523, 659, 784, 1047].forEach((f, i) => tone('triangle', [f, f], [0.1], 0.18, 0.18, i * 0.07));
  },
  moonstone() {
    [880, 1319, 1760, 2637].forEach((f, i) => tone('sine', [f, f], [1], 0.13, 1.4, i * 0.09));
  },
  friend() {
    [660, 880, 990, 1320, 1760].forEach((f, i) => tone('sine', [f, f], [0.2], 0.12, 0.35, i * 0.08));
  },
  swipe() {
    noise(0.12, 0.3, { type: 'bandpass', f: 1800, q: 2 }, 0, 6500);
    noise(0.08, 0.15, { type: 'bandpass', f: 2500, q: 3 }, 0.05, 7000);
  },
  hit() {
    tone('square', [320, 140], [0.08], 0.12, 0.1, 0, { type: 'lowpass', f: 1500 });
    noise(0.06, 0.2, { type: 'lowpass', f: 1200 });
  },
  defeat() {
    tone('triangle', [600, 1200], [0.15], 0.14, 0.2);
    [1047, 1319, 1568].forEach((f, i) => tone('sine', [f, f], [0.1], 0.08, 0.2, 0.12 + i * 0.06));
  },
  hurt() {
    tone('sawtooth', [500, 180], [0.25], 0.18, 0.28, 0, { type: 'lowpass', f: 1400 });
  },
  sizzle() {
    noise(0.3, 0.18, { type: 'highpass', f: 3000 });
  },
  powerup() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone('triangle', [f, f], [0.2], 0.14, 0.3, i * 0.08));
  },
  heal() {
    [784, 988, 1175].forEach((f, i) => tone('sine', [f, f], [0.2], 0.12, 0.25, i * 0.07));
  },
  gateOpen() {
    tone('sine', [70, 50], [2], 0.35, 2.2, 0, null, sfxBus, 0.3);
    noise(1.8, 0.12, { type: 'lowpass', f: 300 });
    [523, 784, 1047, 1568].forEach((f, i) => tone('sine', [f, f], [1], 0.12, 1.6, 0.6 + i * 0.18));
  },
  portal() {
    noise(1.0, 0.25, { type: 'bandpass', f: 400, q: 1 }, 0, 4000);
    tone('sine', [200, 1600], [1], 0.15, 1.1);
  },
  jump() {
    tone('sine', [280, 520], [0.1], 0.1, 0.12);
  },
  flutter() {
    tone('triangle', [500, 1100], [0.12], 0.12, 0.15);
    tone('triangle', [700, 1400], [0.1], 0.08, 0.12, 0.06);
  },
  latch() {
    tone('square', [180, 120], [0.06], 0.06, 0.07, 0, { type: 'lowpass', f: 900 });
  },
  land(soft = false) {
    tone('sine', [160, 70], [0.12], soft ? 0.1 : 0.25, 0.14);
  },
  select() {
    tone('triangle', [880, 1100], [0.05], 0.08, 0.06);
  },
};

// ── Generative ambient music ────────────────────────────────
// Each theme: root note, scale, tempo, chord progression (scale degrees), voices.
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export const MUSIC = {
  title: { root: 57, scale: 'lydian', bpm: 64, prog: [0, 4, 5, 3], pad: 'sine', lead: 'sine', density: 0.35, bell: true },
  forest: { root: 55, scale: 'major', bpm: 84, prog: [0, 3, 4, 0, 5, 3, 4, 4], pad: 'triangle', lead: 'triangle', density: 0.5, bass: true },
  winter: { root: 62, scale: 'dorian', bpm: 70, prog: [0, 6, 3, 4], pad: 'sine', lead: 'sine', density: 0.35, bell: true },
  desert: { root: 52, scale: 'phrygian', bpm: 92, prog: [0, 1, 0, 6], pad: 'triangle', lead: 'triangle', density: 0.45, bass: true, shaker: true },
  city: { root: 53, scale: 'mixolydian', bpm: 100, prog: [0, 6, 3, 4], pad: 'triangle', lead: 'square', density: 0.45, bass: true, hats: true },
  lava: { root: 45, scale: 'minor', bpm: 88, prog: [0, 5, 3, 6], pad: 'sawtooth', lead: 'triangle', density: 0.4, bass: true, drum: true },
  marsh: { root: 50, scale: 'dorian', bpm: 76, prog: [0, 3, 4, 3], pad: 'triangle', lead: 'triangle', density: 0.4, bass: true },
  cloud: { root: 60, scale: 'lydian', bpm: 88, prog: [0, 1, 4, 3], pad: 'sine', lead: 'sine', density: 0.5, bell: true },
  fortress: { root: 50, scale: 'minor', bpm: 104, prog: [0, 5, 6, 4], pad: 'sawtooth', lead: 'square', density: 0.45, bass: true, drum: true },
  crystal: { root: 54, scale: 'minor', bpm: 70, prog: [0, 5, 3, 6], pad: 'sine', lead: 'sine', density: 0.3, bell: true },
  moon: { root: 57, scale: 'lydian', bpm: 72, prog: [0, 4, 5, 1], pad: 'triangle', lead: 'sine', density: 0.4, bell: true, bass: true },
};

let current = null, wanted = null;

export function playMusic(name) {
  const cfg = MUSIC[name];
  if (wanted === cfg && current) return;
  wanted = cfg;
  stopMusic();
  if (audioReady()) startMusic(cfg);
}

export function stopMusic() {
  if (!current) return;
  clearInterval(current.timer);
  const g = current.bus;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.linearRampToValueAtTime(0, t + 1.2);
  setTimeout(() => g.disconnect(), 1500);
  current = null;
}

function startMusic(cfg) {
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0, ctx.currentTime);
  bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 2);
  bus.connect(musicBus);
  const scale = SCALES[cfg.scale];
  const eighth = 60 / cfg.bpm / 2;
  const st = { bus, step: 0, next: ctx.currentTime + 0.1, mel: 7, cfg };
  const note = (deg, oct = 0) => {
    const o = Math.floor(deg / 7);
    const d = ((deg % 7) + 7) % 7;
    return cfg.root + scale[d] + 12 * (o + oct);
  };
  const voice = (type, n, t, dur, peak, attack, cutoff) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = midi(n);
    o.detune.value = (Math.random() - 0.5) * 8;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  const perc = (t, f, dur, peak, type = 'highpass') => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    const g = ctx.createGain();
    env(g, t, 0.003, peak, dur);
    n.connect(fl).connect(g).connect(bus);
    n.start(t, Math.random() * 0.5);
    n.stop(t + dur + 0.05);
  };
  const tick = () => {
    while (st.next < ctx.currentTime + 0.4) {
      const t = st.next, s = st.step;
      const bar = Math.floor(s / 8);
      const chordDeg = cfg.prog[Math.floor(bar / 2) % cfg.prog.length];
      if (s % 16 === 0) {
        // pad: a soft triad held for two bars
        for (const d of [0, 2, 4]) voice(cfg.pad, note(chordDeg + d, -1), t, eighth * 16 + 0.6, cfg.pad === 'sawtooth' ? 0.018 : 0.035, 1.2, 900);
      }
      if (cfg.bass && s % 4 === 0) voice('sine', note(chordDeg, -2), t, eighth * 3.5, 0.09, 0.02, 400);
      if (Math.random() < cfg.density && s % 2 === 0 || Math.random() < cfg.density * 0.3) {
        // wandering melody that leans on chord tones
        st.mel += Math.round((Math.random() - 0.5) * 4);
        st.mel = Math.max(4, Math.min(14, st.mel));
        if (Math.random() < 0.35) st.mel = chordDeg + [0, 2, 4][Math.floor(Math.random() * 3)] + 7;
        voice(cfg.lead, note(st.mel), t, eighth * (1.5 + Math.random() * 2), cfg.lead === 'square' ? 0.025 : 0.05, 0.01, cfg.lead === 'square' ? 1800 : 3000);
      }
      if (cfg.bell && s % 8 === 6 && Math.random() < 0.5) voice('sine', note(chordDeg + 4, 2), t, 2.5, 0.025, 0.005, 6000);
      if (cfg.hats && s % 2 === 1) perc(t, 7000, 0.03, 0.03);
      if (cfg.shaker && Math.random() < 0.6) perc(t, 5000, 0.05, 0.02, 'bandpass');
      if (cfg.drum && s % 8 === 0) voice('sine', 40, t, 0.35, 0.18, 0.005, 200);
      st.next += eighth;
      st.step++;
    }
  };
  tick();
  st.timer = setInterval(tick, 120);
  current = st;
}
