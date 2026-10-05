# Sprite Specification — Characters (cutout pieces, 3 views)

This is the contract between artists and the engine. Characters are **cutout
puppets**, like old Flash games: each body is a set of separate pieces that the
engine rotates around their joints to animate walking, sprinting, aiming and
firing. Artists draw each piece once per view; there are no animation frames.

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

## Pieces

| Piece                    | Contains                                  | Pivot (joint it hangs from) |
| ------------------------ | ----------------------------------------- | --------------------------- |
| `torso`                  | neck, chest, belly, hips                  | center of the hips          |
| `head`                   | head, hair / mane / crest, ears, snout    | base of the skull (neck)    |
| `headAlt`                | the head with an idle detail (lizardman tongue flick, sergal ear twitch); optional | same as `head` |
| `tail`                   | the whole tail (optional)                 | where it leaves the pelvis  |
| `upperArmA` / `upperArmB` | shoulder (deltoid) + upper arm           | shoulder                    |
| `lowerArmA` / `lowerArmB` | elbow + forearm + hand                   | elbow                       |
| `upperLegA` / `upperLegB` | thigh + knee                             | hip joint                   |
| `lowerLegA` / `lowerLegB` | shin (+ metatarsus for digitigrade) + foot | knee                      |

**A / B** are the two sides: screen-left / screen-right in the front and back
views, **far / near** in the side view. Draw far pieces a shade darker.

Rules for pieces:
- Draw each piece **whole**, as if nothing overlapped it: an arm doesn't stop
  where the chest would cover it. Rotating pieces must never open gaps.
- Round off both ends at the joints (a knee is round on the thigh *and* the
  shin piece), so the joint looks solid at any angle.
- Outline every piece on its own (colored outline, see Style).
- Pose: the **bind pose** is standing, limbs straight down and slightly apart
  (front/back: arms a little out from the body). The engine's rotations are
  relative to it.

## Atlas layout

One PNG per race (and per armor piece set), layout `puppet`
(`content/base/sprites/puppet.json`):

| Property   | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| Cell size  | **48 × 48 px**                                                |
| Rows       | **3** views: `down` (front), `right` (side), `up` (back). `left` is `right` mirrored by the engine |
| Columns    | **12** pieces in this order: torso, head, headAlt, tail, upperArmA, lowerArmA, upperArmB, lowerArmB, upperLegA, lowerLegA, upperLegB, lowerLegB |
| Sheet size | **576 × 144 px**                                              |
| Format     | PNG, RGBA, no color profile (or sRGB), no premultiplied alpha |

Leave a missing piece's cell empty (humans have no tail). Keep pieces at least
1 px away from their cell edges.

Each piece's pivot is a point in its cell, and the bind-pose position of every
joint is part of the race's **rig** (`PuppetRig` in `src/render/puppet.ts`):
piece pivots, plus elbow, hand-center (grip), knee and foot-contact positions.
Generated races compute their rig; drawn atlases will ship a rig JSON next to
the PNG.

The character stands on its feet point (the rig `anchor`). The held weapon
pivots **31 px above the feet** (`CHEST_HEIGHT` in `src/game/combat.ts`), and
the hands are posed onto its grip and foregrip with IK. Bullets hit anything
inside a box about 50 px tall above the feet.

## Animations (done by the engine)

- **Idle:** breathing, tail sway, now and then `headAlt`.
- **Walk / sprint:** legs stride with IK so feet plant on the ground; the
  cycle advances with distance travelled. Sprinting leans forward, lengthens
  the stride and pumps the free arm; the gun is carried low.
- **Aim:** both hands hold the gun, which points at the aim in any direction;
  in side view the torso and head turn toward it.
- **Fire:** the gun and arms kick back and the muzzle climbs.
- **Reload:** the gun tips up toward the chest.

Posed characters are drawn at 1× into a shared texture and scaled up with the
camera, so rotated pieces keep square pixels.

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

Armor is drawn as extra atlases layered on top of the body, using **the same
layout and pivots**: a helmet's `head` cell lines up pixel-for-pixel with the
body's `head` cell, so gear moves with the piece it's on.

Draw order, bottom to top (`PAPER_DOLL_ORDER` in `src/render/CharacterView.ts`):

1. `body`: the race's base atlas (bare, or in a simple undersuit)
2. `legs`: pants + boots (on the leg pieces, plus the belt on the torso's hips)
3. `torso`: top/vest (torso piece) + sleeves, pads and gloves (arm pieces)
4. `head`: helmet / hood (head pieces)

Each race needs its own armor atlases, because the bodies differ (tails,
snouts, ears, digitigrade legs). An armor atlas:
- is transparent everywhere except the gear,
- may cover body pixels (a helmet hides hair),
- leaves the `tail` cell empty.

Paint the main fabric or plating of armor in the **secondary** key colors. The
armor's `dye` setting recolors those regions, so one atlas can serve as an
olive military vest and a black mercenary vest. Fixed parts (straps, metal
buckles, visor glass) use normal colors.

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
