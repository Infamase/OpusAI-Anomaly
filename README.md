# Stalker: Future Anomaly

A 2D pixel-art, top-down survival shooter in the spirit of S.T.A.L.K.E.R., set
across procedurally generated planets, ships and space stations. It runs in the
browser on **PC and iPad** (WebGPU with a WebGL fallback).

> Status: **Phase 0 (Foundation) is complete.** A character can walk around a
> generated, chunk-streamed test map using keyboard/mouse, gamepad or iPad
> touch controls. Race, colors and map edits persist through reloads.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from other devices on your LAN)
npm test           # unit tests
npm run build      # typecheck + production build into dist/
```

**On an iPad:** run `npm run dev` on your PC and open the "Network" URL it prints
(same Wi-Fi), or use the GitHub Pages build (see below). For fullscreen and
reliable saves, use **Share → Add to Home Screen**.

URL flags: `?renderer=webgl` forces WebGL, `?debug=1` opens the dev panel.

## Controls

| Action | Keyboard / mouse | Gamepad | iPad touch |
| --- | --- | --- | --- |
| Move | WASD / arrows | Left stick | Left half: floating stick |
| Aim | Mouse | Right stick | Right half: aim stick |
| Fire | Left click / Space | RT | Push the aim stick past its outer ring |
| Sprint | Shift | L3 | RUN (toggle) |
| Use / Reload | E / R | A / X | USE / RLD |
| Pause | Esc | Start | ❚❚ |
| Dev panel | ` or F3 | Select | DEV |

The **dev panel** switches race (Human / Lizardman / Sergal), color, zoom and
renderer. It also has a build mode (E/USE toggles a wall in front of you, to
test map saves) and can save, export, import, or start a new world.

## Project layout

```
content/base/        game data (races, stats, tiles, world templates). Add content here
docs/                ARCHITECTURE.md (how to extend) · SPRITE_SPEC.md (art contract)
public/              static files (icons, manifest; sprite PNGs go in public/sprites/)
src/core/            game loop, scenes, events, RNG, settings
src/render/          PixiJS renderer, camera, tilemap, paper-doll, palette swap, placeholder art
src/input/           keyboard/mouse, gamepad, touch → actions
src/ecs/ src/stats/  entity-component-system, stat & modifier system
src/content/         content registry, schemas, pack loader
src/save/            IndexedDB saves, migrations, world deltas
src/game/            components, systems, world generation, scenes
tests/               vitest unit tests
```

## Roadmap

| Phase | Modules | Status |
| --- | --- | --- |
| 0 Foundation | Core, Renderer, Input, ECS/Content/Stats, Save | ✅ |
| 1 Vertical slice | Paper-doll armor, world & collision, combat, inventory, AI & factions, HUD & character creator | next |
| 2 Worlds | Planet generation, station/ship chunk generation, alien fauna, anomalies & artifacts | |
| 3 Space & progression | Space map, player ship, boarding, economy & the two shop stations, NPCs/quests, audio & polish | |

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the tests, builds the game, and publishes
`dist/` on every push to `main`. One-time setup: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

## Note on names

"S.T.A.L.K.E.R." is a trademark of GSC Game World, and the sergal species was
created by Mick (Mick39). Both are fine for a personal or fan project. Before
any commercial release, rename the game and get permission for sergals. The
data-driven design keeps that a content change.
