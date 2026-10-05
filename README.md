# Stalker: Future Anomaly

A 2D pixel-art, top-down survival shooter in the spirit of S.T.A.L.K.E.R., set
across procedurally generated planets, ships and space stations. It runs in the
browser on **PC** (WebGPU with a WebGL fallback), with keyboard/mouse or a gamepad.

> **Status:** Phase 0 (foundation), Module 6 (armor + character creator + menus),
> Module 8 (combat), Module 9 (inventory) and Module 10 (AI & factions) are done.
> You can make a character and start at a Loner outpost on a generated map,
> with a bandit den and an army patrol out in the field. NPCs spot, hear and
> hunt each other (and you), take cover, reload, heal and call out to their
> squad. Dead NPCs stay dead and their bodies keep their loot. Five weapons,
> six ammo types, a weight-limited backpack, saves you can move between PCs.
>
> **Art:** 64px characters with realistic proportions, colored outlines and
> soft lighting, plus muted, textured terrain with blended ground, pine forests,
> boulders and tank-room style interiors. All of it is generated in code
> (`src/render/placeholder/`) and can be replaced with drawn PNGs per
> `docs/SPRITE_SPEC.md`.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # typecheck + production build into dist/
```

Chrome or Edge give the best results (WebGPU). Other browsers fall back to WebGL
automatically. URL flags: `?renderer=webgl` forces WebGL, `?debug=1` opens the
dev panel.

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move / aim | WASD / mouse | Left / right stick |
| Fire | Left click | RT |
| Reload | R | X |
| Primary / sidearm / swap | 1 / 2 / Q or mouse wheel | RB |
| Sprint (lowers your gun, uses stamina) | Shift | L3 |
| Interact (pick up, open crate, search body) | E | A |
| Inventory | Tab or I | Y |
| Quick heal (bandage if bleeding, else best medkit) | H | D-pad down |
| Pause | Esc | Start |
| Dev panel | ` or F3 | Select |

**Inventory:** double-click to equip or use, drag between slots, backpack and
containers, drag outside the window to drop on the ground, Shift-click to move
items straight into or out of a container. Hovering an item compares it with
what you have equipped.

Point at an NPC to see its name, faction and how it regards you (red hostile,
yellow neutral, green friendly). Shooting a faction you aren't at war with
costs reputation; enough of it and they turn on you.

The **dev panel** is testing scaffolding: give weapons, god mode, heal,
spawn squads of any NPC type, clear NPCs, reset reputation, swap armor, change race/color, zoom, renderer, build mode
(E toggles walls), save/export, regenerate the world.

## Saves across PCs

*Load Game → Export* downloads a `.sfa.json` file. On the other PC, use
**Import Save** on the main menu. If that save already exists there, you choose
whether to replace it or keep both.

## Project layout

```
content/base/        game data: races, stats, tiles, armor, weapons, ammo, consumables, loot tables, factions, NPC templates, worlds
docs/                ARCHITECTURE.md (how it fits together, how to extend) · SPRITE_SPEC.md (art contract)
public/              static files (icons, manifest; sprite PNGs go in public/sprites/)
src/core/            game loop, scenes, events, RNG, settings
src/render/          PixiJS renderer, camera, tilemap, paper-doll, combat effects, icons, placeholder art
src/input/           keyboard/mouse, gamepad → actions
src/ecs/ src/stats/  entity-component-system, stat & modifier system
src/content/         content registry, schemas, pack loader, item catalog
src/save/            IndexedDB saves, migrations, world deltas
src/game/            components, systems (weapons, projectiles, vitals...), AI (brains, pathfinding), factions, items, scenes
src/ui/              HUD, dev panel, DOM helpers
tests/               vitest unit tests
```

## Roadmap

| Phase | Modules | Status |
| --- | --- | --- |
| 0 Foundation | Core, renderer, input, ECS/content/stats, saves | ✅ |
| 1 Vertical slice | ✅ Armor + creator + menus · ✅ combat · ✅ inventory · ✅ AI & factions · ✅ art overhaul · HUD polish & sound | in progress |
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
