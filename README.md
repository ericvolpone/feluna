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
  (claw them, or jump on them) to open the cage. Clearing every guard in a level
  earns a powerup.
- **Hearts:** you start with 3. Enemies and lava take one each. Defeated enemies
  sometimes drop a heart. Out of hearts ends the run.
- **Tuna cans (20 per level):** find them all for a powerup.
- **Powerups:** Swift Paws (+speed), Spring Legs (+jump), Extra Heart (+1 max).
- **Climbing:** swipe next to a trunk, lamp post or drainpipe to latch on, hold
  claws to climb, jump to leap off.
- **Minimap:** shows the gate, moonstones, remaining tuna, wild birds and
  guarded camps, so you can tell when a level is 100% complete.

### Birds

Each level has 5 wild birds, one of each kind. Walk up calmly and meow 3 times
to befriend one. Each friend has a job and follows you between levels:

| Bird | Job |
| --- | --- |
| Cardinal | Fighter: swoops at guards near you |
| Canary | Fetcher: brings you nearby tuna and hearts |
| Bluebird | Scout: flies toward the nearest moonstone, leaving a sparkle trail |
| Robin | Healer: brings you a heart now and then |
| Chickadee | Guardian: puffs up a shield that blocks one hit |

Befriending a kind you already have levels that friend up instead. Befriend
all 5 birds in a level to unlock the next jump tier: Double Jump → Triple Jump
→ Glide → Quadruple Jump → Five Jumps.

### Phones and tablets

Touch devices get on-screen controls automatically (play in landscape):

- **Left half:** a floating joystick appears under your thumb. Drag past the ring to sprint.
- **Right half:** drag to turn the camera. It also eases back behind your cat while you run.
- **Buttons:** Jump, Claws (hold to climb, auto-aims at nearby guards), Meow, Pause.
- **Menus:** tap a cat to choose, tap again to play. Tap powerup cards to pick.

Phones also get lighter rendering (lower resolution, smaller shadows, less grass).

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
| `src/input.js` | Unified keyboard/mouse, Gamepad API and touch input |
| `src/touch.js` | On-screen joystick and buttons for phones/tablets |
| `src/device.js` | Touch-device detection and lite rendering flag |
| `src/ui3d.js` | Canvas-textured text panels and button glyphs |
| `src/sky.js` | TSL gradient sky shader |
