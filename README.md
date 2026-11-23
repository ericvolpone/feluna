# Feluna

A browser roguelite (early prototype) starring two cats: **Felix** and **Luna**.

Built with [Three.js](https://threejs.org) `WebGPURenderer` (uses WebGPU, falls back to WebGL 2 automatically) and Vite.
All models are procedural low-poly geometry with procedural animation — no external art assets.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. Chrome/Edge (WebGPU) recommended; Safari and Firefox work too.

## Gameplay

A run is five levels: **Whisker Woods → Frostpaw Peaks → Sunscratch Dunes →
Alley City → Ember Crater**.

- **Moonstones (5 per level):** each sits at a point of interest (canopy walks,
  spiral trees, towers, floating isles, a pyramid, rooftops, a lava crossing...).
  Find all 5 to open the **Moon Gate** straight ahead of the spawn, then walk
  through it to reach the next level.
- **Guarded camps (2 per level):** their moonstone is caged. Defeat the guards
  (claw them, or jump on them) to open the cage and pick a powerup.
- **Hearts:** you start with 3. Enemies and lava take one each. Defeated enemies
  sometimes drop a heart. Out of hearts ends the run.
- **Tuna cans (20 per level):** every 10 gives you a powerup choice.
- **Powerups:** Swift Paws (+speed), Spring Legs (+jump), Extra Heart (+1 max).
- **Climbing:** swipe next to a trunk, lamp post or drainpipe to latch on, hold
  claws to climb, jump to leap off.
- **Birds:** walk up calmly and meow 3 times to make a friend. Friends shrink,
  follow you, and carry over between levels. 1 friend = Flutter (mid-air jump),
  3 = Glide (hold jump while falling), 5 = Double Flutter.

## Controls

| Action | Controller | Keyboard / Mouse |
| --- | --- | --- |
| Move | Left stick / D-pad | WASD / Arrows |
| Look | Right stick | Mouse (click canvas to capture) |
| Jump (hold for higher) | A | Space |
| Sprint | LT / LB (hold) or L3 (toggle) | Shift |
| Claws (swipe / climb) | RT / RB | E / Left click |
| Meow | X | F |
| Pause | Start | Esc / P |
| Menu select / back | A / B | Enter / Esc |

Debug: `feluna.warp(2)` in the browser console jumps to a level (0-4).

Music and sound effects are synthesized. Browsers only start audio after a click or key
press (controller buttons don't count), so click once if you don't hear anything.

## Layout

| File | Purpose |
| --- | --- |
| `src/main.js` | Renderer setup, scene switching, game loop |
| `src/menu.js` | Title screen + hero select (fully in-canvas) |
| `src/game.js` | Gameplay scene: run state, powerups, gate, camera, pause |
| `src/player.js` | Character controller, climbing, flutter/glide, collision |
| `src/cat.js` | Procedural cat model + animation rig |
| `src/heroes.js` | Hero definitions (stats, colors) |
| `src/levels.js` | The five level themes: palettes, terrain, POIs, enemies |
| `src/world.js` | Level builder: terrain, POIs, Moon Gate, collectibles, collision |
| `src/enemies.js` | Blob and beetle guards, combat |
| `src/birds.js` | Songbirds: perching, flying, befriending, following |
| `src/particles.js` | Billboard particles (hearts, notes, sparkles, slashes) |
| `src/audio.js` | Synthesized sound effects + generative music per level |
| `src/input.js` | Unified keyboard/mouse + Gamepad API input |
| `src/ui3d.js` | Canvas-textured text panels and button glyphs |
| `src/sky.js` | TSL gradient sky shader |
