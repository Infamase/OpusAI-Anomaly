# Stalker: Future Anomaly

A 2D pixel-art, top-down survival shooter in the spirit of S.T.A.L.K.E.R., set
across procedurally generated planets, ships and space stations. It runs in the
browser on **PC** (WebGPU with a WebGL fallback), with keyboard/mouse or a gamepad.

> **Status:** Phase 1 (the vertical slice) is complete; Phase 2 has started
> with **planet generation**. New characters arrive at the Rookie Village on
> the Northern Zone, a 512×512-tile planet generated from a seed: meadows,
> pine forests, swamps, wasteland and rocky highlands, lakes and rivers,
> farmhouses, bandit hideouts, an army checkpoint, a ruined factory, roads
> (with bridges) joining them, and patrols walking the roads. The PDA map (M)
> fills in as you explore. NPCs spot, hear and
> hunt each other (and you), take cover, reload, heal and call out to their
> squad. Dead NPCs stay dead and their bodies keep their loot. Five weapons,
> six ammo types, a weight-limited backpack, saves you can move between PCs.
>
> **Sound:** every sound is synthesized from recipes in content files
> (gunshots per weapon, footsteps per surface, impacts, pain and death per
> race, reloads, radio chatter, UI, wind and the hum of the Zone), positioned
> around you and muffled with distance. Any of them can be swapped for a
> recording. **HUD:** minimap, damage direction, status effects, magazine pips,
> kill feed, plus an Options screen for volumes and display.
>
> **Animation:** characters are Flash-style cutout puppets (separate torso,
> head, arm and leg pieces) with procedural walk, sprint, aim, fire and reload:
> hands hold the gun and follow the aim in any direction.
>
> **Art:** 64px characters with realistic proportions, colored outlines and
> soft lighting, plus muted, textured terrain with blended ground, pine forests,
> boulders and tank-room style interiors. All of it is generated in code
> (`src/render/placeholder/`) and can be replaced with drawn PNGs per
> `docs/SPRITE_SPEC.md`.

## Run it

**Step-by-step for Windows (double-click `play.bat`) and the web-link option:
see [docs/RUNNING.md](docs/RUNNING.md).** For developers:

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # typecheck + production build into dist/
```

Chrome or Edge give the best results (WebGPU). Other browsers fall back to WebGL
automatically. URL flags: `?renderer=webgl` forces WebGL, `?debug=1` opens the
dev panel, `?mute=1` starts muted. Sound, zoom and renderer settings are under
**Options** (title screen or pause menu).

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
| PDA map | M | D-pad up |
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
spawn squads of any NPC type, clear NPCs, reset reputation, swap armor, change race/color, zoom, renderer, travel between worlds, build mode
(E toggles walls), save/export, regenerate the world.

## Saves across PCs

*Load Game → Export* downloads a `.sfa.json` file. On the other PC, use
**Import Save** on the main menu. If that save already exists there, you choose
whether to replace it or keep both.

## Project layout

```
content/base/        game data: races, stats, tiles, biomes, structures, armor, weapons, ammo, consumables, loot tables, factions, NPC templates, sounds, worlds
docs/                RUNNING.md (play it on your PC) · ARCHITECTURE.md (how it fits together, how to extend) · SPRITE_SPEC.md (art contract)
public/              static files (icons, manifest; sprite PNGs go in public/sprites/)
src/core/            game loop, scenes, events, RNG, settings
src/audio/           sound synthesizer and WebAudio engine
src/render/          PixiJS renderer, camera, tilemap, paper-doll, combat effects, icons, placeholder art
src/input/           keyboard/mouse, gamepad → actions
src/ecs/ src/stats/  entity-component-system, stat & modifier system
src/content/         content registry, schemas, pack loader, item catalog
src/save/            IndexedDB saves, migrations, world deltas
src/game/            components, systems (weapons, projectiles, vitals...), AI (brains, pathfinding), factions, items, scenes
src/ui/              HUD, minimap, options, dev panel, DOM helpers
tests/               vitest unit tests
```

## Roadmap

| Phase | Modules | Status |
| --- | --- | --- |
| 0 Foundation | Core, renderer, input, ECS/content/stats, saves | ✅ |
| 1 Vertical slice | Armor + creator + menus · combat · inventory · AI & factions · art overhaul · cutout animation · sound · HUD | ✅ |
| 2 Worlds | ✅ Planet generation · station/ship chunk generation · alien fauna · anomalies & artifacts | in progress |
| 3 Space & progression | Space map, player ship, boarding, economy & the two shop stations, NPCs/quests, music & polish | |

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the tests, builds the game, and publishes
`dist/` on every push to `main` (the game is then at
https://infamase.github.io/OpusAI-Anomaly/). One-time setup: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

## Note on names

"S.T.A.L.K.E.R." is a trademark of GSC Game World, and the sergal species was
created by Mick (Mick39). Both are fine for a personal or fan project. Before
any commercial release, rename the game and get permission for sergals. The
data-driven design keeps that a content change.
