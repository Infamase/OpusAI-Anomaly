# Architecture

## The main rule: engine code never names content

Systems (rendering, movement, generation, saving) operate on *definitions*
loaded from JSON. No code says "lizardman" or "AK-74". Adding a race, tile,
weapon, faction or planet type means adding a data file. Only a genuinely new
*kind of behavior* needs code.

```
content/<pack>/**/*.json ──► ContentRegistry ──► systems read defs by id
                               (validated,       (races, tiles, stats,
                                cross-checked)    world generators…)
```

## Modules (Phase 0)

| Module | Folder | What it owns |
| --- | --- | --- |
| 1 Core | `src/core/` | `Game` (wires everything), fixed-timestep `GameLoop` (60 Hz sim, any display rate), `SceneManager` (stack: world + overlays), typed `EventBus`, seeded `Rng`/noise, `Settings` |
| 2 Renderer | `src/render/` | `GameRenderer` (PixiJS v8, WebGPU with an automatic WebGL fallback), `Camera` (whole-number zoom), `TilemapRenderer` (each chunk drawn into one cached texture), `CharacterView` (paper-doll layers), `SpriteSheetCache` + `palette.ts` (color swapping) |
| 3 Input | `src/input/` | Keyboard/mouse and gamepad sources → one `InputManager` exposing actions (`move`, `aim`, `fire`, `reload`…) |
| 4 ECS / Content / Stats | `src/ecs/`, `src/content/`, `src/stats/` | Minimal ECS `World`; content packs, schemas, registry; `StatBlock` (base → flat → percent → multiplier) |
| 5 Save | `src/save/` | `SaveManager`, IndexedDB/memory backends, versioned migrations, per-world `WorldDeltas` |
| Game | `src/game/` | Components, systems, character factory, world generators, `TileMap`, scenes |

### Frame flow

```
requestAnimationFrame
 └─ FixedStepper: 0..5 sim steps of 1/60 s
     ├─ InputManager.update()        poll devices → actions
     └─ SceneManager.update(dt)      top scene (and those below, if it doesn't block)
          └─ World.update(dt)        PlayerControl → Movement → Animation
 └─ SceneManager.render(alpha)       interpolate positions, set frames, camera, stream chunks
 └─ GameRenderer.render()
```

## Scenes

```
MainMenuScene ──New Game──► CharacterCreatorScene ──Begin──► GameplayScene ⇄ PauseScene (overlay)
      ▲  ├─Continue / Load Game (pick a slot) ─────────────────────▲    │
      │  └─Import Save (file → slot, with replace/keep-both prompt)     │
      └──────────────────────── Save & Quit to Menu ◄──────────────────┘
```

Scenes are stacked by `SceneManager`. Only gameplay captures game keys
(`Game.setGameplayInput`); menus get normal keyboard behaviour. Menus are DOM
over the canvas and draw animated characters with `CharacterPreview`.

## Equipment and paper-doll armor (Module 6)

- **Content:** `armor` defs (`content/base/armor/*.json`) have `slot` (`head`,
  `torso` = top + gloves, `legs` = pants + boots), `fitsRace` (must equal a
  race's `armorTag`), `modifiers`, `weight`, `value`, `dye`, and art: `sheet`
  (a PNG) or `placeholder.style`. Races list `startingEquipment`.
- **Items:** an `ItemInstance` `{uid, defId, condition}` is what saves store.
  Defs are content; instances belong to the player.
- **Stats:** equipping adds the def's modifiers with source `item:<uid>`, and
  unequipping removes exactly those (`src/game/equipment.ts`).
- **Rendering:** `CharacterView` draws `body → legs → torso → head`, each its
  own sheet in the same layout. Armor is recolored by its `dye` through the
  secondary key colors.
- **Placeholder armor** (`src/render/placeholder/armor.ts`) is painted using the
  body-part tags the body generator records per pixel. One set of rules fits
  every body shape, and a tail drawn in front of the body is never covered.

## Extension points

### Add a playable race
1. `content/base/races/<id>.json`: copy `human.json`, then change the stats, colors and hitbox.
2. Art: a PNG sheet following `docs/SPRITE_SPEC.md` in `public/sprites/`, with `"sheet": "sprites/<id>.png"`.
   (Or add a placeholder generator to `src/render/placeholder/characters.ts`.)
3. Done: the dev panel's race list, the stats and saving all pick it up.

### Add armor
Add an entry to `content/base/armor/<race>.json`: pick a `slot`, set `fitsRace`
to the race's `armorTag`, and choose a `placeholder.style` (`hood`/`helmet`,
`jacket`/`plate_vest`, `pants`/`plate_legs`) or point `sheet` at a PNG drawn
per `docs/SPRITE_SPEC.md`. Use `dye` for color variants. A new playable race
needs its own armor pieces, and its `startingEquipment` must fit it (the loader
checks this).

### Add a stat
Add an entry to `content/base/stats/core.json`. Races set it via `baseStats`.
Gear, artifacts and cybernetics will add modifiers with `source` tags, and
`StatBlock.removeSource()` removes them cleanly.

### Add a tile
Add it to `content/base/tiles/*.json` with `solid`, `opaque` and placeholder art
settings. Saves store tile **ids**, so adding or removing tiles never corrupts
existing worlds. A saved tile whose id no longer exists falls back to the
generated tile.

### Add a world/planet type
- **Same algorithm, different settings:** a new `worldGen` JSON with different `params`.
- **New algorithm:** implement `WorldGenerator` (`src/game/world/generators.ts`)
  and call `registerGenerator()`. Generation must be a pure function of
  `(seed, chunk coords, params)`. Bump `version` whenever the output for a seed
  changes. Worlds record the generator version they were created with.

### Add a new kind of content (weapons, armor, factions, station chunks…)
1. `src/content/types/<kind>.ts`: a schema (`v.object({...})`), a `crossCheck` for
   references, and a `declare module '../Registry'` line to register its TypeScript type.
2. One line in `src/content/types/index.ts`.
3. Data files under `content/<pack>/`.

### Content packs (expansions / mods)
`content/<pack>/pack.json` declares `id`, `version`, `dependencies`. Packs load
in dependency order. A pack can override any def by reusing its `type` + `id`.
Overrides are logged.

### Add an input action
Add it to `BUTTON_ACTIONS` (`src/input/actions.ts`), then add default bindings in
`src/input/bindings.ts`.

## Saves: "seed + changes"

```
IndexedDB "stalker-future-anomaly"
 ├─ slots   key slotId            SaveData { version, meta, player, worlds: { id → {genId, seed, genVersion} }, flags }
 └─ chunks  key [slot, world, cx,cy]  ChunkDelta { tiles: {localIndex → tileId}, removed: [...], entities: [...] }
```

- A world is never stored whole, only its recipe (generator id + seed) plus what
  the player changed. When the player returns, the chunks are regenerated and the
  changes are applied on top.
- Autosaves happen every 30 s, when the app is hidden/closed (`visibilitychange`/`pagehide`), and on manual save. Only chunks that changed are written.
- Undoing a change (back to the generated tile) deletes the record, so saves stay small.
- **Format changes:** bump `SAVE_VERSION` and add a step in `src/save/migrations.ts`.
  Current format is **v2** (v1 → v2 added `player.equipment`).
- **Slots:** each character is its own slot (`slot-<time>-<random>`). Export
  writes `{format: "sfa-save", data, chunks}` JSON. Import upgrades older
  formats and asks before replacing a slot that already exists.
- Browsers can evict website storage under disk pressure. The game requests
  persistent storage, and saves can be exported as JSON backups.

## Rendering notes

- The canvas runs at full device resolution, the camera zoom is a whole number
  (about 340 world px visible vertically), and textures use nearest-neighbour
  filtering. Together these keep pixel art crisp at every size.
- **WebGPU** is preferred. Before Pixi starts, a raw WebGPU probe presents a few
  frames. If the device dies, the game uses WebGL instead, and repeated device
  losses at runtime switch the setting to WebGL and reload. `?renderer=webgl`
  forces WebGL. The probe runs before Pixi because tearing down a Pixi renderer
  and creating another in the same page corrupts Pixi's texture bookkeeping.
- Recoloring happens on the CPU once per (sheet, colors) combination and is
  cached. NPC generation should pick colors from race presets so the cache stays bounded.
