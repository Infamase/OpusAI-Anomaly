# Sprite Specification — Characters (48px, 4 directions)

This is the contract between artists and the engine. Any sheet that follows it
drops into the game with **no code changes**: put the PNG in `public/sprites/`
and point the race (or, later, armor) definition's `sheet` field at it.

The placeholder art generated in `src/render/placeholder/characters.ts`
follows this exact spec. Replace it one race at a time.

## Frame grid

| Property     | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| Frame size   | **48 × 48 px**                                                 |
| Directions   | **4**, row order: `down`, `left`, `right`, `up`                |
| Anchor       | **(24, 44)**: the point between the feet, on the ground        |
| View         | Top-down 3/4 (you see the front and the top of the head)       |
| Format       | PNG, RGBA, no color profile (or sRGB), no premultiplied alpha  |

The anchor is the spot that sits on the character's world position. Keep the
feet on row 44 in every frame, or the character will appear to bob or slide.

`left` and `right` are separate rows. Never flip one to make the other in-engine,
because gear can be asymmetric (a shoulder pad on one side, a holster on one hip).

## Sheet layout

Each animation takes 4 rows, one per direction. Columns are frames.

```
row = animationIndex * 4 + directionIndex
col = frameIndex
```

Current layout `humanoid48` (`content/base/sprites/humanoid48.json`):

| Rows | Animation | Frames | FPS | Notes                                                |
| ---- | --------- | ------ | --- | ---------------------------------------------------- |
| 0–3  | `idle`    | 4      | 5   | Breathing. Lizardman: tongue flick on a frame. Tails sway |
| 4–7  | `walk`    | 6      | 10  | Also used, sped up, for sprinting until `run` exists |

Sheet size = (most frames in any animation × 48) by (animations × 4 × 48).
Today that's **288 × 384 px**. Unused cells to the right of shorter animations
stay transparent.

**Adding animations** (`run`, `aim`, `shoot`, `reload`, `hurt`, `death`, …):
append rows to the layout JSON and to every sheet that uses it. Code asking for
an animation a sheet doesn't have falls back to the first one (`idle`), so a sheet
missing new rows still works.

## Recolorable regions (hair / fur / scales)

Paint recolorable areas using these **exact reserved key colors**, from darkest to lightest.
At load time the engine replaces them with a 4-shade ramp built from the player's
or NPC's chosen color. Shadows shift toward blue and highlights toward yellow.

| Channel     | Shade 0 (shadow) | Shade 1   | Shade 2 (base) | Shade 3 (highlight) | Used for                 |
| ----------- | ---------------- | --------- | -------------- | ------------------- | ------------------------ |
| `primary`   | `#400040`        | `#800080` | `#c000c0`      | `#ff00ff`           | Hair / scales / fur      |
| `secondary` | `#004040`        | `#008080` | `#00c0c0`      | `#00ffff`           | Body: unused for now. **Armor: the dyeable fabric/plating** |

Rules:
- Never use these 8 colors anywhere else in the art.
- Export without color management. The engine loads PNGs with color conversion
  turned off, but a tool that converts colors on export will shift key colors
  and break the swap.
- A race lists which channels it uses in `colorChannels`. Shade 2 is the
  color the player picks.

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

## Tiles (for reference)

Tiles are **32 × 32 px**. Solid tiles (walls, rock) have two forms: a top face,
and a front face drawn when walkable ground lies directly south. The front face
gives walls apparent height. Tileset sheets will get their own spec once
Phase 2 (planets/stations) begins.
