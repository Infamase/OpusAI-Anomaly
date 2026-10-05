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

## Modules

| Module | Folder | What it owns |
| --- | --- | --- |
| 1 Core | `src/core/` | `Game` (wires everything), fixed-timestep `GameLoop` (60 Hz sim, any display rate), `SceneManager` (stack: world + overlays), typed `EventBus`, seeded `Rng`/noise, `Settings` |
| 2 Renderer | `src/render/` | `GameRenderer` (PixiJS v8, WebGPU with an automatic WebGL fallback), `Camera` (whole-number zoom), `TilemapRenderer` (each chunk drawn into one cached texture, with blended ground edges and wall shadows; props as depth-sorted sprites), `CharacterView` (paper-doll layers), `SpriteSheetCache` + `palette.ts` (5-tone color swapping), `placeholder/` (generated art: `rig.ts` rasterizer, characters, armor, weapons, tiles, props) |
| 3 Input | `src/input/` | Keyboard/mouse and gamepad sources → one `InputManager` exposing actions (`move`, `aim`, `fire`, `reload`…) |
| 4 ECS / Content / Stats | `src/ecs/`, `src/content/`, `src/stats/` | Minimal ECS `World`; content packs, schemas, registry; `StatBlock` (base → flat → percent → multiplier) |
| 5 Save | `src/save/` | `SaveManager`, IndexedDB/memory backends, versioned migrations, per-world `WorldDeltas` |
| Game | `src/game/` | Components, systems, character factory, world generators, `TileMap`, scenes |
| 6 Armor | `src/game/equipment.ts`, `src/render/placeholder/armor.ts` | Paper-doll armor, race fit, condition-scaled protection |
| 8 Combat | `src/game/combat.ts`, `src/game/systems/{Weapon,Projectile,Vitals}System.ts` | Weapons, projectiles, damage vs resistances, bleeding, stamina |
| 9 Inventory | `src/game/items.ts`, `inventoryActions.ts`, `loot.ts`, `consumables.ts`, `scenes/InventoryScene.ts` | Backpack, weight limit, equip/use/drop, crates and bodies, consumables, item icons |
| 10 AI & factions | `src/game/factions.ts`, `npcs.ts`, `population.ts`, `src/game/ai/` | Faction relations & reputation, NPC templates, camps, NPC brains, A* pathfinding, bodies that persist |
| 11 Sound | `src/audio/`, `src/game/GameAudio.ts`, `content/*/sounds/` | Synthesized (or recorded) sounds as content, WebAudio mixer with positional audio, gameplay and UI sounds, ambience |
| 12 HUD & options | `src/ui/Hud.ts`, `Minimap.ts`, `OptionsPanel.ts` | Vitals, status effects, weapon panel, minimap, damage direction, kill feed; per-device options |

### Frame flow

```
requestAnimationFrame
 └─ FixedStepper: 0..5 sim steps of 1/60 s
     ├─ InputManager.update()        poll devices → actions
     └─ SceneManager.update(dt)      top scene (and those below, if it doesn't block)
          └─ World.update(dt)        PlayerControl → NpcBrain → Weapons → Movement →
                                     Projectiles → Vitals → Encumbrance → Animation
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
- **Cutout characters** (`src/render/puppet.ts`): bodies are rigid pieces
  (torso, head, upper/lower arms, upper/lower legs, tail) posed at runtime.
  `solvePose(rig, state)` is a pure function from what the character is doing
  (moving, sprinting, aim angle, recoil, reload) to bone transforms: legs use
  IK to plant the feet, arms use IK to hold the gun's grip and foregrip.
  `CharacterView` draws the posed pieces (body + armor layers + gun) at 1x into
  a slot of one shared render texture, redrawn in a single pass (≤30 Hz) only
  when a pose changes; `composePuppet` does the same on the CPU for portraits,
  item icons and tests.
- **Generated characters** (`src/render/placeholder/characters.ts`) draw each
  piece from a bind-pose skeleton (digitigrade legs for sergals and lizardmen)
  out of round primitives in `rig.ts`, a small "2.5D" rasterizer: each part is
  a height field, lit from the top-left, quantized onto a 5-tone ramp, with
  colored outlines. Props (trees, boulders) use the same rasterizer.
- **Placeholder armor** (`src/render/placeholder/armor.ts`) is painted piece by piece using the
  body-part tags the body generator records per pixel. One set of rules fits
  every body shape, and a tail drawn in front of the body is never covered.

## Combat (Module 8)

- **Content:** `weapon` defs (slot primary/sidearm, ammo types, fire mode, rate,
  damage × pellets, spread/move spread/bloom, speed, range, reload, armor
  piercing, recoil) and `ammo` defs (damage multiplier, AP bonus, stack size).
- **Intents → shots:** the player's input or an AI writes intents to the
  `Combatant` component (`trigger`, `wantReload`, `wantSwitch`). `WeaponSystem`
  turns them into shots and reloads. Rounds in the magazine live on the
  weapon's `ItemInstance` (`loaded`, `loadedAmmo`), so they're saved
  automatically. Reloads pull from the `Inventory`. If the loaded ammo type has
  run out, the next accepted type is used and the old rounds go back into the
  backpack.
- **Projectiles** are swept every tick against walls (tile DDA) and hurtboxes,
  so fast bullets never tunnel. Characters of the same faction don't hit each
  other.
- **Damage:** `dealt = amount × (1 − clamp(resist − AP, 0, 0.9))`, where resist
  is the target's `<damageType>_resist` stat. A random armor piece (torso 60%,
  legs 25%, head 15%) loses condition. Resist stats flagged
  `scalesWithCondition` shrink with wear (down to 30%). Ballistic and rupture
  hits that get through cause bleeding.
- **Feedback** goes through `CombatEvents` (shot, hit, impact, death, ...) to
  effects, the HUD, the camera and sound.
- Projectiles never hit their owner or anyone with the same `Faction` id.

## Inventory (Module 9)

- **Items:** armor, weapons, ammo and consumables share one id namespace
  (`src/content/items.ts`). An inventory is a plain `ItemInstance[]`. Stackable
  items merge up to their `maxStack`.
- **Weight:** backpack plus worn gear, against the `carry_weight` stat. Over the
  limit you move at 70% speed and can't sprint; over 140% of it, 25% speed
  (`EncumbranceSystem`).
- **Containers:** generators place world objects per chunk (`WorldGenerator.objects`)
  with stable ids. A crate's contents are rolled from its `lootTable` with a seed
  derived from the world seed and the crate id, so they're identical every visit
  until changed. After that, they're saved as a chunk entity record. Bodies of
  killed NPCs become containers holding everything they owned (see Module 10).
- **Ground items** are chunk entity records (`kind: "item"`) and spawn and
  despawn with their chunk, like crates.
- **UI:** `InventoryScene` (paper doll, backpack, container, details with
  equipped-item comparison; drag & drop). Item icons are generated from the same
  art the game draws (`ItemIcons`).

## AI & factions (Module 10)

- **Factions** (`content/*/factions/`) list attitudes to other factions
  (`hostile` / `neutral` / `friendly`, else `defaultAttitude`), callsigns and
  barks (short spoken lines per situation: greet, contact, hurt, reload,
  retreat, angry, search). Two factions are hostile if *either* side says so.
- **The player** has `Faction` id `"player"`. `Relations` (`src/game/factions.ts`)
  treats them like their affiliation (Loners for now), shifted by personal
  reputation per faction (saved in `save.flags.standing`): hitting or killing
  members of a faction that isn't already hostile costs reputation; at -40 it
  turns hostile. NPCs also hold **grudges**: whoever attacks an NPC becomes
  hostile to its whole squad, whatever the factions say.
- **NPC templates** (`content/*/npcs/`) describe a kind of NPC: faction, skill
  range, allowed races, armor sets (armor items carry a `set`), weapons, spare
  magazines, carried items and an optional `pockets` loot table.
  `generateFromTemplate` turns one into a concrete NPC with real gear and ammo.
- **Camps** come from the world generator (`WorldGenerator.population`): an id,
  faction, a template per member, guard or patrol, and a home/route. Members get
  stable ids (`<camp>:<n>`) and seeds derived from the world seed, so the same
  people come back every visit. `Population` (`src/game/population.ts`) spawns
  them and skips the dead (saved as `removed` ids under the `population` delta
  key).
- **Bodies** are world entity records (`kind: "body"`) with the look, name and
  the items still on the body, so a half-looted corpse stays half-looted.
- **Brains** (`NpcBrainSystem`) are a small state machine:
  `idle`/`patrol` → `investigate` (heard a shot) → `combat` → `retreat` (hide and
  heal). Perception: a 150° view cone (~380 px), a close "feel" radius, line of
  sight through tiles, and an awareness meter that fills faster for skilled NPCs
  and noisy targets. Shots are heard ~560 px away. Squads alert each other.
  In combat NPCs keep a weapon-appropriate range, strafe, hide while reloading,
  fire in bursts with skill/range/movement-based aim error, switch to the
  sidearm when out of ammo, and never fire through a non-hostile in the way.
  Brains only write intents (velocity, aim, `Combatant` flags), exactly like the
  player's controls, so combat rules are shared.
- **Pathfinding** (`src/game/ai/pathfinding.ts`): A* on the tile grid, 8
  directions without corner cutting, bounded node budget, then string-pulled
  into straight walkable segments.
- **On screen:** `WorldLabels` (DOM) shows barks over heads and a name tag
  (name, faction, rank, attitude) for the NPC under the cursor.

## Sound (Module 11)

- **Sounds are content** (`content/*/sounds/*.json`). A `sound` def has either
  a `synth` recipe or a `file` (a recording under `public/`), plus its mixer
  `bus` (`sfx`, `ambient`, `voice`, `ui`), `volume`, `range` (px; 0 = not
  positional), `maxVoices`, `minInterval`, `pitchJitter` and `variants`.
- **Synth recipes** (`src/audio/synth.ts`) stack layers (sine, square, saw,
  triangle, white/brown noise, crackle) with a pitch sweep, a sweeping filter,
  attack/hold/decay and an optional wobble, then drive, echo and peak
  normalization. `loop: true` renders a seamless loop for ambience. Each
  variant is a different seed, so repeats don't sound identical. It is pure
  code and unit-tested.
- **Cues:** code names *moments* (`SOUND_CUES`: `shot`, `footstep`,
  `hit_flesh`, `ui_click`, `ambient`, …) and a sound def claims one with
  `"cue"`. More specific references win: a weapon's `sounds.shot`, a tile's
  `sounds.step` / `sounds.impact`, a race's `sounds.hurt` / `sounds.death`, a
  consumable's `sounds.use`, a faction's `sounds.bark`, a world's `ambient` loops.
- **Playback** (`AudioEngine`): starts on the first click or key press
  (browser rule), renders every buffer ahead of time, pans and attenuates
  positional sounds around the player, muffles distant ones, limits voices per
  sound and in total, runs through a limiter, ducks effects while paused or
  dead, and suspends when the tab is hidden. Without WebAudio it's a no-op.
- **Gameplay hookup** (`GameAudio`) listens to `CombatEvents` and gets
  footsteps from the walk cycle (each time a foot plants), barks, pickups and
  item use from the scenes. Volumes per bus live in the per-device settings.

## HUD and options (Module 12)

- `Hud` (DOM over the canvas, updated only when a value changes): health with
  a damage trail, stamina, status effects (bleeding, healing, exhausted,
  overloaded), armor wear, the quick-heal count, the weapon panel (magazine
  pips, low/empty states, reload hint, holstered weapon), prompts with keycaps,
  messages and the kill feed, red arcs pointing toward whoever hit you, and a
  low-health vignette.
- `Minimap`: one pixel per tile, scaled up crisp, north-up, redrawn 10 times a
  second. Tile colors come from tile defs; walls read bright and trees dark.
  People appear when close or in line of sight, colored by attitude; crates,
  bodies and loose items are marked.
- `OptionsPanel` (title screen and pause menu): volume per bus, mute, camera
  zoom, renderer and the performance overlay, saved per device.

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

### Add a weapon, ammo type, consumable or loot table
Add JSON under `content/base/weapons/`, `ammo/`, `consumables/` or `loot/`.
Weapons use `placeholder.style` (`pistol`, `smg`, `rifle`, `shotgun`, `sniper`)
or a `sprite` PNG pointing right with `grip` and `muzzle` pixel coordinates.
Every item id must be unique across all item types (the loader checks). A new
item *kind* means adding it to `ITEM_CONTENT_TYPES` in `src/content/items.ts`.

### Add a faction, NPC type or camp
1. Faction: add an entry to `content/base/factions/` (relations, names, barks).
2. NPC type: add an `npcTemplate` to `content/base/npcs/` (armor sets come from
   armor items' `set` field).
3. Camp: list it in the world's params (`camps` in `content/base/worlds/test_range.json`);
   planet generators will place camps the same way via `population()`.

### Add a stat
Add an entry to `content/base/stats/core.json`. Races set it via `baseStats`.
Gear, artifacts and cybernetics will add modifiers with `source` tags, and
`StatBlock.removeSource()` removes them cleanly.

### Add a tile
Add it to `content/base/tiles/*.json` with `solid`, `opaque` and placeholder art
settings. `blend` makes ground spill over lower-valued neighbors with a ragged
edge; `prop` (`pine`, `dead_tree`, `boulder`, `bush`) stands a tall sprite on
the tile. World params can scatter props with `decor` entries. Saves store tile **ids**, so adding or removing tiles never corrupts
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

### Add or replace a sound
1. Add a def to `content/base/sounds/*.json` with a `synth` recipe (copy a
   similar one) or `"file": "audio/<name>.ogg"` with the file in `public/audio/`.
2. Point something at it (`"sounds": { "shot": "<id>" }` on a weapon, `step` on
   a tile, …) or give it a `"cue"` to make it the default for that moment.
3. To audition recipes, render them to WAV with `synthesize()` (see
   `tests/audio.test.ts`).

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
- Chunk records also hold **world entity records** `{id, kind, x, y, data}`:
  dropped items (`kind: "item"`), the contents of containers the player has
  touched (`kind: "container"`) and NPC bodies (`kind: "body"`). The special
  delta key `population` lists generated NPCs who died.
- **Format changes:** bump `SAVE_VERSION` and add a step in `src/save/migrations.ts`.
  Current format is **v3** (v2 added `player.equipment`; v3 added weapon slots,
  `player.inventory`, `activeWeapon`, `health`).
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
