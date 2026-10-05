# Stalker: Future Anomaly

A 2D pixel-art, top-down survival shooter in the spirit of S.T.A.L.K.E.R., set
across procedurally generated planets, ships and space stations. It runs in the
browser on **PC** (WebGPU with a WebGL fallback), with keyboard/mouse or a gamepad.

> Status: **Phase 0 (Foundation) and Module 6 (paper-doll armor) are complete.**
> The game opens on a main menu (New Game, Load Game, Import Save). New Game
> leads to a character creator (name, race, color, starting gear). In game, each
> race wears its own layered armor (helmet / top + gloves / pants + boots) with
> stat bonuses, on a generated, chunk-streamed test map, using keyboard/mouse,
> gamepad. Saves hold multiple characters and can be
> moved between devices.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from other devices on your LAN)
npm test           # unit tests
npm run build      # typecheck + production build into dist/
```

Chrome or Edge give the best results (WebGPU). Firefox and other browsers fall
back to WebGL automatically.

URL flags: `?renderer=webgl` forces WebGL, `?debug=1` opens the dev panel.

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move | WASD / arrows | Left stick |
| Aim | Mouse | Right stick |
| Fire | Left click / Space | RT |
| Sprint | Shift | L3 |
| Use / Reload | E / R | A / X |
| Pause | Esc | Start |
| Dev panel | ` or F3 | Select |

The **dev panel** (testing scaffolding until inventory exists) can equip any
armor that fits your race, switch race/color, zoom, renderer, toggle a build
mode (E/USE toggles a wall in front of you, to test map saves), save, export,
and regenerate the world.

## Saves across devices

Every save slot can be **exported** from *Load Game → Export* (downloads a
file). On the other PC, use **Import Save** on the main menu and pick the
`.sfa.json` file. If that save is already there, you choose whether to replace
the copy on this device or keep both.

## Project layout

```
content/base/        game data (races, stats, tiles, world templates). Add content here
docs/                ARCHITECTURE.md (how to extend) · SPRITE_SPEC.md (art contract)
public/              static files (icons, manifest; sprite PNGs go in public/sprites/)
src/core/            game loop, scenes, events, RNG, settings
src/render/          PixiJS renderer, camera, tilemap, paper-doll, palette swap, placeholder art
src/input/           keyboard/mouse, gamepad → actions
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
| 1 Vertical slice | ✅ Paper-doll armor + character creator + menus · combat · inventory · AI & factions · HUD | in progress |
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
