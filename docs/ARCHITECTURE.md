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
| 13 Planets | `src/game/world/planetGenerator.ts`, `exploration.ts`, `scenes/MapScene.ts`, `content/*/biomes`, `content/*/structures` | Planet generation (biomes, lakes, rivers, structures, roads), explored-area map |
| 14 Anomalies & artifacts | `src/game/systems/AnomalySystem.ts`, `ArtifactSystem.ts`, `radiation.ts`, `ai/hazards.ts`, `src/render/AnomalyFx.ts`, `content/*/anomalies`, `content/*/artifacts` | Hazards, bolts, radiation, artifacts on the belt, detectors |
| 15 Interiors | `src/game/world/interiorGenerator.ts`, `drawings.ts`, `content/*/rooms`, `src/content/types/{room,legend}.ts` | Labs, ships and stations assembled from room drawings; portals between worlds |
| 16 Doors & destructibles | `src/game/doors.ts`, `breakables.ts`, `src/render/CrackOverlay.ts`, `content/*/tiles/doors.json`, `content/*/keycards` | Doors, keycards and locked rooms, breakable walls / fences / barricades / crates |
| 17 Explosives | `src/game/explosives.ts`, `src/content/types/explosive.ts`, `src/render/ExplosionFx.ts`, `content/*/explosives` | Grenades, placed charges, blasts, world hazards, NPC grenade use |
| 18 Light & darkness | `src/game/lighting.ts`, `worldLighting.ts`, `src/render/LightRenderer.ts` | Clock and daylight, light sources and shadows, the lightmap, light levels for NPC eyes |
| 19 Fire & weather | `src/game/fire.ts`, `weather.ts`, `src/render/FireFx.ts`, `WeatherFx.ts`, `content/*/tiles/fire.json` | Spreading fire, burning and cook-offs, incendiaries; weather spells, rain, storms, fog and wind |
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

## Planets (Module 13)

- **A planet is a `worldGen` def** using the `planet` generator: which
  `biomes`, the border cliffs, elevation and climate scales, `water` (lake
  share, rivers), `roads` (tiles, width, extra loops), the `start` structure
  (and the biomes it prefers), `structures` with counts, spacing and allowed
  biomes, road `patrols`, and wild `crates`. Swap the lists to make a desert,
  tundra or alien jungle planet without code.
- **Biomes** (`content/*/biomes/`) sit at a point in climate space (moisture,
  temperature). Two smooth, warped noise fields give every spot a climate and
  the nearest biome wins, so neighbors are sensible (swamp next to forest, not
  desert). A biome has a base ground, noise `patches` of other ground, rock
  outcrops, swamp `pools`, `decor` (density + clumping into groves) and
  optional ambience. Shares of area are exact: noise is converted to ranks
  through sampled distribution tables, so `"cover": 0.2` really covers 20%.
- **Structures** (`content/*/structures/`) are ASCII drawings with a legend:
  tile ids, `terrain` (keep), `clear` (keep terrain, remove trees and rocks),
  crates, the camp's home (`camp`), road connection (`entrance`) and the
  player's arrival (`spawn`). They can be rotated and mirrored, decay into
  ruins (`decay`, `rubble`) and house a camp (with a `chance`).
- **The plan** (once per seed, ~0.2 s): elevation / moisture / temperature on
  a 4-tile grid; rivers walk downhill from high ground into lakes (or end in a
  pond); structures are placed by rule (the start near the middle); a minimum
  spanning tree plus a few extra links joins their entrances, each link routed
  with A* on a 2-tile grid that avoids walls and prefers dry, open ground
  (bridges where it must cross water); river and road distances are stamped
  into per-tile arrays. **Chunks** (~0.4 ms each) then read the plan and
  per-tile noise, in priority order: border, structures, roads/bridges,
  water, pools, rocks, ground, decorations.
- **Tiles** gained `low` (blocks walking, not bullets: water) and `speed`
  (mud 0.8, shallows 0.6).
- **Map:** `Exploration` keeps a bit per chunk the player has been near
  (base64 in the save's flags). The PDA map (`MapScene`, M) shows explored
  terrain, discovered places and the player; the HUD shows the current place
  or biome, and biomes switch the ambience.
- **Worlds per character:** the save's `player.worldId` decides the world.
  New characters start on `zone_north`; older saves stay where they were. The
  dev panel can travel between worlds.

## Anomalies & artifacts (Module 14)

- **Anomalies** (`content/*/anomalies/`) combine four behaviors: a `burst`
  (set off by anything alive or a thrown bolt coming within `radius`, after a
  `windup`, then a `cooldown`; damage of `damageType` with knockback or
  pull-in), `pull` (drag toward the center), `dot` (damage per second while
  inside) and `radiation` (dose per second, strongest at the center). `style`
  picks the look and sound; `visibility` how easy it is to see. The Zone has
  burners, electros, vortexes, acid pools and invisible radiation hot spots.
- **`AnomalySystem`** runs after the controls and AI (so pulls add to their
  movement) and before movement; anomalies hurt NPCs too. Damage over time is
  dealt in 0.4 s chunks (one hit event, not sixty). Deaths record a cause
  ("Killed by a burner anomaly.") for the death screen.
- **Bolts** (G): `throwBolt` + `BoltSystem` fly a bolt in an arc; it bounces,
  lies there for a while, and sets off anomalies it lands in.
- **Radiation** (`game/radiation.ts`): a dose in `Health.rads`, taken in
  through `radiation_resist`, cleared at `0.5 + 1%` per second, and above
  30 rads it costs health. A steady source settles at a predictable dose
  (`equilibriumDose`). Anti-rad and vodka flush it (`antiRad` consumable
  effect). The HUD shows the dose; a Geiger counter clicks with the intake.
- **Artifacts** (`content/*/artifacts/`, item kind `artifact`) grow inside the
  anomalies listed in `spawnsIn`, weighted by `rarity`. Worn on the three belt
  slots (`belt1..3`), they add stat `modifiers` (like armor), and
  `ArtifactSystem` applies their `radiation` (negative = cleansing) and
  `regen` over time.
- **Detectors** (item kind `detector`) work from the backpack (the best one
  counts): the HUD shows signal strength and distance (and a direction arrow if
  `direction`), they beep faster as you close in, and artifacts within
  `reveal` become visible. Until then they're hidden (and off the minimap).
- **On planets** the generator places anomaly `fields` (anomaly kinds, count,
  members, spread, biomes, artifact chance) off roads, out of places and away
  from the start, plus `stray` single anomalies; artifacts sit inside a
  matching anomaly's reach. Fields are map landmarks (red rings). Taken
  artifacts are saved as removals of generated objects.
- **NPCs** know where anomalies are (`HazardMap`, filled as their chunks load):
  paths treat those tiles as very expensive, straight-line shortcuts never
  cross them, and they never pick a goal inside one.

## Interiors (Module 15)

- **Rooms** (`content/*/rooms/`) are drawings like structures, but in theme
  slots instead of fixed tiles: `$wall`, `$floor`, `$floor2`, `$door`,
  `$outside`, `$accent`, `$window`. The same storage room becomes a white lab,
  a rusty hold or a station module depending on the world's `theme`. `D`
  cells on the outer wall (not corners) are **door sockets**. Rooms may hold
  crates, anomalies, camps (`camp` with a `chance`), a `spawn` cell and
  **portals**. Tags group them (`corridor`, `lab`, `cargo`, `landmark`…).
- **The interior generator** (`generator: "interior"`) starts with the
  `start` room in the middle and keeps attaching rooms at open sockets:
  rotated to fit, sharing the wall, never covering another room's floor.
  Pools in `rooms` (by id or tag) have `weight`, `min` and `max`; minimums
  are filled first. Where two rooms' sockets happen to meet, a door opens
  with chance `loops` (more loops, fewer dead ends); every other socket is
  sealed. The whole layout is one plan per seed, cut into chunks like any
  world. `areaAt` names the room you're in (the HUD shows it); rooms tagged
  `landmark` go on the map.
- **Drawings** (`world/drawings.ts`, `content/types/legend.ts`) are shared by
  structures and rooms: one legend format, one resolver, one validator
  (rooms may use theme slots, structures may not).
- **Portals** are legend cells: `{ "tile": "hatch", "portal": { "world":
  "underground_lab", "label": "Climb down into the lab" } }`. A generator lists
  them (`portals()`); standing next to one shows `E <label>`. Going in records
  `return:<world>` in the save's flags (which world and which door you came
  from), so a `"@return"` portal leads back out the same door. Arrival puts
  you on the nearest open tile beside the matching portal.
- The Zone has three: a **Research Bunker** (down into Lab X-16), a
  **Crashed Freighter** (half-buried, outside is rock), and a **Launch Site**
  (a shuttle up to the orbital station, outside is space).

## Doors, keycards & destructibles (Module 16)

- **Doors are tiles** with a `door` field: using one (E, or an NPC walking into
  it) swaps it for its `toggle` tile, closed (solid, opaque) ↔ open. The change
  is saved like any tile change. A door won't close on someone standing in it.
- **Locks:** a closed door with `door.key` opens only for someone carrying that
  **keycard** (item kind `keycard`, never used up). Opening it swaps it to the
  open tile, whose toggle is an ordinary unlocked door, so it stays unlocked.
- **NPCs:** pathfinding treats closed doors that open for anyone as passable
  (`TileMap.blocksPath`, `TileSet.openable`) and won't cut diagonally through a
  doorway; `DoorSystem` opens the door just ahead of a walking NPC. Locked
  doors stay walls to them, so guards in a locked room stay put until you
  open it.
- **Breakables:** a solid tile with `breakable` (`hp`, `becomes`, `resist`,
  `debris`) wears down under bullets: `ProjectileSystem` reports the tile it
  struck (`tileHit`), `TileDamage` keeps the wear and swaps in the broken tile
  (saved) when it runs out. Worn tiles show cracks (`CrackOverlay`); partial
  wear lasts for the visit only. Fragile walls become debris, fences
  splinters, barricades rubble.
- **Breakable props:** entities with a `Breakable` component (wooden supply
  crates; military cases are steel) take bullets too (`propHit`). A crate shot
  apart spills its contents onto the ground and is gone for good (saved as a
  removed generated object).
- **Interiors** use it all through their params: `doors` (closed doors in a
  share of doorways), `locks` (rooms tagged `secure` get the locked door
  tile; the keycard is placed in a room reachable from the entrance without
  passing a lock or a barricade), `barricades`, and `secrets` (a fragile wall
  where two unjoined rooms share a wall, a shortcut to shoot through). The
  theme's `fragile` slot picks that wall.
- **Fences** come in an east-west (`fence`) and a north-south (`fence_ns`)
  tile; a tile's `turned` names its quarter-turned form, so rotated structures
  keep their fences running the right way.

## Explosives (Module 17)

- **Content** (`content/*/explosives/`, item kind `explosive`): `use` is
  `throw` (grenades) or `place` (charges); `trigger` is `fuse`, `proximity`
  or `tripwire`; `blast` gives radius, damage (falling to a quarter at the
  edge), damage type and armor piercing, knockback, `shatter` (damage to
  breakable tiles and crates) and an optional `cone` (claymores). Charges
  have `sense` (reach), `delay` (click / beep before the bang), `arming`
  (time to walk away) and `hidden` / `spotRange` (landmines).
- **`ExplosiveSystem`** (one `Explosive` component for both kinds):
  thrown grenades fly with gravity, bounce, then roll; on landing their
  rolling friction is set so they stop near the aim point, and the fuse
  only starts **once they're at rest** (so there's always a moment to get
  away). Walls (and closed doors) bounce them; high enough they clear
  fences and barricades. Placed charges arm, then trigger on anyone not of
  their `faction` (the placer's side, or a camp's own traps) within reach
  or across the tripwire, after a line-of-sight check, and on bolts.
- **Blasts** damage everyone in reach with a clear line from the center
  (walls shelter you), throw them back, emit `tileHit` for breakable tiles
  (only where nothing else solid is in the way) and `propHit` for crates,
  and set off other explosives nearby a moment later. Shooting a charge sets
  it off (it has a 1 hp `Breakable`).
- **Player:** F throws the first grenade in the backpack at the cursor; V
  (or "Place" in the backpack) sets down the first charge a step ahead,
  facing the cursor; E picks up your own charges or disarms spotted ones.
  Placed charges are saved with their chunk; generated hazards are saved as
  removals once used or disarmed. The HUD shows what F / V would use and
  points at live grenades near you; live grenades get a red danger ring,
  claymores a faint tripwire laser.
- **NPCs** hear blasts, and run from a live grenade within reach (a beat
  later if they only heard it land), sprinting to a spot outside the blast,
  off known hazards, holding fire meanwhile. They **throw** only to flush out
  someone who ducked out of sight 2.5–9 s ago, at 4 tiles or more, onto a
  spot they can lob to that reaches the target, never with a friend within
  the blast; each NPC then waits 50–80 s and nobody else may throw for
  18–30 s. They shout before throwing.
- **World hazards:** planets have `minefields` (landmines off the roads with
  a warning sign facing the nearest road; on the map as hazards); structure
  and room legends take `explosive` cells (claymores face away from the
  drawing's middle; owned by the place's camp); interiors' `traps` put a
  claymore or IED just inside some doorways with the wire across the way in.
  NPC routes avoid them (`HazardMap`).

## Light & darkness (Module 18)

- **The clock** lives in the save (`flags.clock`, minutes) and runs at
  `CLOCK_RATE` (a day is 36 real minutes) in every world. `daylight()` maps
  the time to a sky color (night blue, dawn rose, white day, amber dusk).
- **Worlds** opt in with `lighting` in their `worldGen`: `dayCycle` follows the
  clock (planets); otherwise a fixed `ambient` color (dim labs, a near-black
  wreck). Without it a world is always fully lit and lighting is skipped.
- **Light sources** (`WorldLighting`): generator lights (`lights()`: the
  interior generator's ceiling `lamps`, some dead, some flickering), glowing
  tiles (`light` on a tile: campfires, lamp posts; picked up as chunks stream
  in), anomalies with `light` (burners, electros, acid), revealed artifacts,
  flashlights (`Flashlight` component: a beam in the aim direction plus a
  little spill), and brief flashes (gunfire, explosions). A faint glow around
  the player keeps the dark from being total.
- **Shadows:** each light's reach is a polygon cast against opaque tiles
  (`lightPolygon`: rays stop a little into the first wall, so the face
  catching the light is lit). Fixed lights cache theirs until a tile near
  them changes (a door opens, a wall falls).
- **The lightmap** (`LightRenderer`): a quarter-resolution render texture
  filled with the ambient color, each light added as its polygon filled with
  a radial gradient (`falloff`), then laid over the world with a multiply
  blend. In daylight it isn't drawn at all. The brightness option lifts the
  ambient.
- **Eyes:** `WorldLighting.levelAt(x, y)` is the ambient plus every light
  reaching a point (walls considered); holding a lit flashlight counts as
  brightly lit. NPCs (`NpcBrainSystem.lightAt`) see an unlit target only
  close up, and out to full range as the light on it rises. In the dark,
  NPCs switch their flashlights on.

## Fire & weather (Module 19)

- **What burns** is content: `burns: { "fuel": seconds, "spread": 0..1, "becomes": "<tile>" }`
  on a tile (grass, reeds, bushes, trees, planks, fences, barricades, wooden
  doors). Burnt tiles turn into their `becomes` (scorched earth, charred
  trees, charred planks). Water and walls never burn; bare floor burns only
  where fuel was spilled (a Molotov's `blast.fire.fuel`).
- **`FireMap`** holds the burning tiles and their heat. Each step a fire may
  spread to a neighbour (chance from `spread`, heat, and the wind: it runs
  downwind and barely creeps upwind); a child fire starts a little cooler, so
  a blaze dies out over distance rather than eating a whole map. Rain
  shortens burns, stops spreading in a downpour and puts fires out; a tile
  put out early is left as it was. Capped at `MAX_CELLS`.
- **`FireSystem`** burns anyone standing in flames (`BURN_DPS`, "Burned to
  death."), cooks off placed charges after a short delay, and burns crates.
  NPCs treat fire as a hazard (`avoid` hook): they dodge out of it and route
  round it. Fires light the night (clustered into `extraSources`).
- **Incendiaries:** an explosive with `blast.fire: { radius, fuel }` sets
  flammable ground alight on detonation (line of sight from the blast);
  `trigger: "impact"` bursts on landing with no roll or fuse (Molotov).
  Anomalies with `ignites` (burners) light the grass when they go off.
- **Weather** is a pure function, `weatherAt(seed, minutes, odds, override?)`:
  time is cut into spells (`WEATHER_SPELL`, six game hours), each spell's kind
  is picked from the world's `weather` odds by a hash of seed and spell, and
  the last 50 minutes of a spell blend into the next. The first two spells
  are always clear. So it needs no saving and is the same on every PC.
  Kinds: clear, cloudy, rain, storm (heavy rain, gales, lightning), fog.
- **Effects:** `weatherTint` dims and greys the daylight (dayCycle worlds),
  `weatherSight` shortens NPC sight in fog and rain, wind steers fire and
  smoke, rain douses fires. Storms strike lightning near the player (a flash
  through `WorldLighting.strike()`, a bolt, thunder, and it can light the
  grass). The HUD clock shows the weather; rain, gale and fire sound beds
  fade with it (`GameAudio.beds`).
- **Drawing:** `FireFx` (flames, embers and smoke drifting with the wind,
  scorch), `WeatherFx` (rain streaks and splashes, two seamless fog layers
  scrolling with the wind, lightning bolts). The dev panel can force a
  weather kind.

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
edge; `prop` (`pine`, `dead_tree`, `boulder`, `bush`, `leafy_tree`, `reeds`,
`wreck`, `rubble`) stands a tall sprite on the tile; `low` makes a solid tile
that bullets fly over; `speed` slows walking. World params can scatter props with `decor` entries. Saves store tile **ids**, so adding or removing tiles never corrupts
existing worlds. A saved tile whose id no longer exists falls back to the
generated tile.

### Add a biome or a structure
- **Biome:** a def in `content/base/biomes/` (copy one), then list its id in a
  planet's `biomes`. Pick a climate point away from the others.
- **Structure:** a def in `content/base/structures/`: draw `map` rows of equal
  width, define every character in `legend`, give it an `entrance` cell, then
  add `{ "id": ..., "count": [min, max] }` to a planet's `structures`.
  Structures are placed in list order, so put important ones first; the
  minimum count is always met (if the biome and spacing rules leave no room,
  they're relaxed).

### Add a world/planet type
- **Another planet:** a new `worldGen` JSON with `"generator": "planet"` and its own biomes and structures.
- **Same algorithm, different settings:** a new `worldGen` JSON with different `params`.
- **New algorithm:** implement `WorldGenerator` (`src/game/world/generators.ts`)
  and call `registerGenerator()`. Generation must be a pure function of
  `(seed, chunk coords, params)`. Bump `version` whenever the output for a seed
  changes. Worlds record the generator version they were created with.

### Add a room, an interior or a way in
- **Room:** a def in `content/base/rooms/`: draw it with theme slots
  (`$wall`, `$floor`…), put `D` sockets on the outer walls (at least one, never
  on a corner), tag it, then let an interior's `rooms` pool pick it up by tag
  or id.
- **Interior:** a `worldGen` JSON with `"generator": "interior"`: a `theme`
  (a tile for every slot), a `start` room holding a `"@return"` portal, room
  pools, a room `count` and `loops`.
- **Way in:** a legend cell with a `portal` in a planet structure (or another
  room), pointing at the interior's id.

### Add a door, keycard or breakable
- **Door:** two tiles that name each other in `door.toggle`, one solid (closed,
  `door_closed` / `wood_door` style) and one walkable (open). Give them
  `open` / `close` sounds.
- **Locked door + keycard:** a `keycard` in `content/base/keycards/`, and a
  closed door tile with `door.key` set to it whose `toggle` is the open tile.
  Use it in an interior's `locks`, or draw it into a structure (and put the
  keycard in a loot table).
- **Breakable:** add `breakable: { "hp": ..., "becomes": "<tile>" }` to any
  solid tile, plus a `break` sound.

### Add a grenade, mine or other charge
- A def in `content/base/explosives/` (copy the closest one): `use`,
  `trigger`, `blast`, `art`, `sounds`. Put it in loot tables, NPC `carries`,
  a planet's `minefields`, an interior's `traps` or a drawing's legend
  (`{ "clear": true, "explosive": "<id>" }`).

### Add a light
- **Glowing tile:** `"light": { "color": "#ffa050", "radius": 6, "intensity": 1, "flicker": 0.5 }` on a tile (drawn into structures like any tile).
- **Lamps in an interior:** `lamps` in its params (color, radius, how many work, how many flicker).
- **Glowing anomaly:** `light` on the anomaly def.
- **A dark world:** `"lighting": { "ambient": "#20242c" }` (or `"dayCycle": true`) on its `worldGen`.

### Make something burn, or add weather
- **Flammable tile:** `"burns": { "fuel": 6, "spread": 0.6, "becomes": "<burnt tile>" }`.
- **Incendiary:** `"blast": { ..., "fire": { "radius": 2.5, "fuel": 9 } }` on an explosive; `"trigger": "impact"` to burst on landing.
- **Weather on a world:** `"weather": { "clear": 4, "cloudy": 3, "rain": 3, "storm": 1, "fog": 1.5 }` (relative odds) on its `worldGen`. New kinds go in the `KIND` table in `src/game/weather.ts`.

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

### Add an anomaly, artifact or detector
- **Anomaly:** a def in `content/base/anomalies/` (behavior numbers + `style`),
  then list it in a planet's `anomalies.fields` or `stray`.
- **Artifact:** a def in `content/base/artifacts/` with `spawnsIn` anomaly ids,
  `modifiers`, `radiation`, `regen` and `art` (shape + colors).
- **Detector:** a def with `range`, `reveal` and `direction`; put it in loot
  tables or starting inventories.

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
