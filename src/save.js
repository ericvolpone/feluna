// Progress saved in the browser (localStorage). For each hero we remember the
// furthest level reached and a snapshot of the run (upgrades, bird friends...) as it
// was at the start of every level, so you can always pick up from any of them.
const KEY = 'feluna.save.v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

const data = read();

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch { /* private mode / storage full: progress just isn't kept */ }
}

function heroSave(id) {
  data.heroes ??= {};
  return (data.heroes[id] ??= { best: 0, snaps: {}, cleared: false });
}

/** The parts of a run worth keeping between sessions. */
function snapshot(run) {
  return {
    maxHearts: run.maxHearts,
    speedLv: run.speedLv,
    jumpLv: run.jumpLv,
    tunaTotal: run.tunaTotal,
    moonTotal: run.moonTotal,
    friends: { ...run.friends },
    flockTier: run.flockTier,
  };
}

export const Save = {
  /** Highest level index this hero has reached (0-based). */
  best(heroId) {
    return heroSave(heroId).best;
  },

  /** Snapshot of the run as it was when this hero started `level`, or null. */
  snapshotAt(heroId, level) {
    return heroSave(heroId).snaps[level] ?? null;
  },

  /** Call when a level begins. */
  levelStarted(run) {
    const h = heroSave(run.hero.id);
    h.snaps[run.level] = snapshot(run);
    h.best = Math.max(h.best, run.level);
    write();
  },

  runCleared(heroId) {
    heroSave(heroId).cleared = true;
    write();
  },

  /** Furthest level reached by any hero, used for unlocks. */
  furthest() {
    return Math.max(0, ...Object.values(data.heroes ?? {}).map((h) => h.best));
  },

  reset() {
    data.heroes = {};
    write();
  },
};
