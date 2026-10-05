# Sprite Specification — Characters (64px, 4 directions)

This is the contract between artists and the engine. Any sheet that follows it
drops into the game with **no code changes**: put the PNG in `public/sprites/`
and point the race (or, later, armor) definition's `sheet` field at it.

The generated art in `src/render/placeholder/characters.ts` follows this exact
spec. Replace it one race at a time.

## Style

Target look (from the project's reference sheets):

- **Proportions:** lean and realistic, about 5–6 heads tall. A standing human
  is ~53 px from feet to crown; sergal ears reach ~4 px higher.
- **Anatomy:** sergals and lizardmen are **digitigrade** (thigh, shin, long
  metatarsus, toes). Tails are part of the body sheet.
- **Light** comes from the **top-left**. Each material uses **4 tones plus an
  outline tone** (shadow, mid, base, highlight + outline).
- **Outlines are colored** ("sel-out"): the silhouette uses the darkest tone of
  the material it borders (deep blue around blue fur, dark red-brown around
  skin), not black. Parts that overlap others (an arm across the chest) get a
  1 px contour in their own outline tone.
- Markings (pale bellies, muzzles, forearms) are separate fixed colors, not
  recolored.

## Frame grid

| Property     | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| Frame size   | **64 × 64 px**                                                 |
| Directions   | **4**, row order: `down`, `left`, `right`, `up`                |
| Anchor       | **(32, 60)**: the point between the feet, on the ground        |
| View         | Top-down 3/4, characters drawn upright (front/side/back)       |
| Format       | PNG, RGBA, no color profile (or sRGB), no premultiplied alpha  |

The anchor is the spot that sits on the character's world position. Keep the
feet on row 60 in every frame, or the character will appear to bob or slide.

`left` and `right` are separate rows. The engine never flips one to make the
other, because gear can be asymmetric (a shoulder pad on one side, a holster on
one hip). (The generated placeholders happen to mirror `right` for `left`.)

The held weapon pivots at chest height, **26 px above the anchor**
(`CHEST_HEIGHT` in `src/game/combat.ts`). Bullets hit anything inside a box
about 50 px tall above the feet.

## Sheet layout

Each animation takes 4 rows, one per direction. Columns are frames.

```
row = animationIndex * 4 + directionIndex
col = frameIndex
```

Current layout `humanoid64` (`content/base/sprites/humanoid64.json`):

| Rows | Animation | Frames | FPS | Notes                                                |
| ---- | --------- | ------ | --- | ---------------------------------------------------- |
| 0–3  | `idle`    | 4      | 5   | Breathing. Lizardman: tongue flick on frame 2. Sergal: ear twitch on frame 3. Tails sway |
| 4–7  | `walk`    | 6      | 10  | Also used, sped up, for sprinting until `run` exists |

Sheet size = (most frames in any animation × 64) by (animations × 4 × 64).
Today that's **384 × 512 px**. Unused cells to the right of shorter animations
stay transparent.

**Adding animations** (`run`, `aim`, `shoot`, `reload`, `hurt`, `death`, …):
append rows to the layout JSON and to every sheet that uses it. Code asking for
an animation a sheet doesn't have falls back to the first one (`idle`), so a sheet
missing new rows still works.

## Recolorable regions (hair / fur / scales)

Paint recolorable areas using these **exact reserved key colors**, from darkest
to lightest. At load time the engine replaces them with a 5-tone ramp built from
the player's or NPC's chosen color. Shadows shift toward blue/purple and
highlights toward yellow; the outline tone is a deep, saturated version of the
color.

| Channel     | Outline   | Shadow    | Mid       | **Base**  | Highlight | Used for                 |
| ----------- | --------- | --------- | --------- | --------- | --------- | ------------------------ |
| `primary`   | `#200020` | `#400040` | `#800080` | `#c000c0` | `#ff00ff` | Hair / scales / fur      |
| `secondary` | `#002020` | `#004040` | `#008080` | `#00c0c0` | `#00ffff` | Body: unused for now. **Armor: the dyeable fabric/plating** |

Rules:
- Never use these 10 colors anywhere else in the art.
- Export without color management. The engine loads PNGs with color conversion
  turned off, but a tool that converts colors on export will shift key colors
  and break the swap.
- A race lists which channels it uses in `colorChannels`. The **base** shade is
  the color the player picks.

## Paper-doll layers (armor)

Armor is drawn as extra full sheets layered on top of the body, using **the
same layout**. A frame in a helmet sheet lines up pixel-for-pixel with the same
frame in the body sheet.

Draw order, bottom to top (`PAPER_DOLL_ORDER` in `src/render/CharacterView.ts`):

1. `body`: the race's base sheet (bare, or in a simple undersuit)
2. `legs`: pants + boots
3. `torso`: top/vest + gloves/gauntlets
4. `head`: helmet

Each race needs its own armor sheets, because the bodies differ (tails, snouts,
ears, digitigrade legs). An armor sheet:
- is transparent everywhere except the gear,
- may cover body pixels (a helmet hides hair),
- must not draw pixels for parts it doesn't cover.

Leave a gap for the tail in `legs` sheets for lizardman and sergal. The tail is
part of the body layer. In the `up` (back) view the tail hangs *in front* of
the legs and lower back, so torso and legs gear must leave those pixels empty
there, or the tail disappears under the armor.

Paint the main fabric or plating of armor in the **secondary** key colors. The
armor's `dye` setting recolors those regions, so one sheet can serve as an
olive military vest and a black mercenary vest. Fixed parts (straps, metal
buckles, visor glass) use normal colors.

In the side view, the arm nearer the camera and the gear on it belong in
`torso`. The far arm is drawn darker in `body`.

## Tiles and props (for reference)

Tiles are **32 × 32 px**, lit from the top-left like the characters. Solid
tiles (walls, rock) have two forms: a top face, and a front face drawn when
walkable ground lies directly south. The front face gives walls apparent
height, and walls cast a short shadow down and to the right onto the floor.

Ground tiles with a `blend` value spill over neighbors with a lower value using
a ragged edge and a dark rim (grass over dirt), so ground textures should tile
seamlessly with themselves.

Props (trees, boulders, shrubs) are tiles with a `prop` style: the ground is
drawn as usual and the prop is a separate sprite, depth-sorted with characters
by its base. A tall prop's base sits about 3/4 of the way down its tile.
Tileset and prop sheets will get their own spec once Phase 2 (planets/stations)
begins.
