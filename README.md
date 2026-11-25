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

A run is ten levels, each with its own challenge:

| # | Level | Focus |
| --- | --- | --- |
| 1 | Whisker Woods | intro: walkable tower, canopy walk, spiral tree |
| 2 | Frostpaw Peaks | ice cave, watchtower |
| 3 | Sunscratch Dunes | pyramid, obelisk, oasis |
| 4 | Lilypad Marsh | deep water, lily pad crossings |
| 5 | Alley City | rooftops, drainpipes, clock tower |
| 6 | Cloudtop Gardens | floating islands, stepping-stone bridges, checkpoint lanterns |
| 7 | Thornback Fortress | combat: four camps and the Thornback boss |
| 8 | Crystal Hollow | dark caverns, tougher guards |
| 9 | Ember Crater | lava |
| 10 | Moonrise Sanctum | hard sky platforming and the Gloom King boss |

- **Moonstones (5 per level):** find them all to open the **Moon Gate**.
- **Guarded moonstones:** caged until you defeat the guards (or boss) nearby.
  Clearing every guard in a level earns a powerup.
- **Tuna cans (20 per level):** find them all for a powerup.
- **Powerups:** Swift Paws (+speed), Spring Legs (+jump), Extra Heart (+1 max).
- **Hearts:** enemies, lava, water and falling off a sky island cost one each.
- **Tower stairs** spiral up the outside with railings; level 1's can simply be
  walked, later ones need hops.
- **Minimap** shows the gate, moonstones, remaining tuna, wild birds and camps.

### Heroes

| Hero | Attack |
| --- | --- |
| Felix | **Claws:** wide swipe in front, short cooldown |
| Luna | **Pounce:** leaps at a nearby enemy and bites for 2, can't be hurt mid-pounce, longer cooldown |

A third, locked hero is teased on the select screen.

### Saved progress

Progress is saved in your browser. After picking a hero you can start from any
level you've reached, with the upgrades and bird friends you had when you got
there. Dying offers **Retry Level N** the same way.

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

Befriending a kind you already have levels that friend up instead: it acts more
often (and Fighter/Fetcher reach farther). Stars on the HUD show each friend's
level, with silver and gold borders past three stars; the pause menu lists exact
numbers for the current and next level. Befriend
all 5 birds in a level to unlock the next jump tier: Double Jump → Triple Jump
→ Glide → Quadruple Jump → Five Jumps.

### Phones and tablets

Touch devices get on-screen controls automatically (play in landscape):

- **Left half:** a floating joystick appears under your thumb. Drag past the ring to sprint.
- **Right half:** drag to turn the camera. It also eases back behind your cat while you run.
- **Buttons:** Jump, Claws (hold to climb, auto-aims at nearby guards), Meow, Pause.
- **Menus:** tap a cat to choose, tap again to play. Tap powerup cards to pick.

Phones also get lighter rendering (lower resolution, smaller shadows, less grass).

**Fullscreen:** on Android the game goes fullscreen on the first tap, and a
⛶ Fullscreen button is on the title screen and in the pause menu. iPhone Safari
can't make web pages fullscreen, so there the button explains how to
**Add to Home Screen**; Feluna then opens as a full-screen app (with its own
saved progress, separate from Safari's).

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
| `src/enemies.js` | Blob and beetle guards, bosses, shockwaves |
| `src/save.js` | Progress saved in localStorage |
| `src/birds.js` | Songbirds: perching, flying, befriending, following |
| `src/particles.js` | Billboard particles (hearts, notes, sparkles, slashes) |
| `src/audio.js` | Synthesized sound effects + generative music per level |
| `src/input.js` | Unified keyboard/mouse, Gamepad API and touch input |
| `src/touch.js` | On-screen joystick and buttons for phones/tablets |
| `src/device.js` | Touch-device detection and lite rendering flag |
| `src/ui3d.js` | Canvas-textured text panels and button glyphs |
| `src/sky.js` | TSL gradient sky shader |
