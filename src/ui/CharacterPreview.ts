import type { Container } from 'pixi.js';
import type { Game } from '../core/Game';
import type { Direction } from '../core/math';
import { prepareCharacterArt, resolveColors } from '../game/characters';
import { armorSheetSrc, ARMOR_SLOTS } from '../game/equipment';
import { CharacterView } from '../render/CharacterView';
import type { ChannelColors } from '../render/palette';
import type { EquipmentSave } from '../save/types';

/**
 * An animated paper-doll character drawn in screen space (menus, creator).
 * Uses the exact same layers and sheets as in-game characters.
 */
export class CharacterPreview {
  readonly view = new CharacterView();
  dir: Direction = 'down';
  anim = 'idle';
  private time = 0;
  private raceId = '';
  private token = 0;

  constructor(
    private game: Game,
    parent: Container,
  ) {
    parent.addChild(this.view.root);
    this.view.root.visible = false;
  }

  /** Changes what is shown. Rapid calls are fine: only the latest one is applied. */
  async set(raceId: string, colors: ChannelColors, equipment: EquipmentSave, showGear = true): Promise<void> {
    const token = ++this.token;
    const { content, sheets } = this.game;
    const gear = showGear ? equipment : {};
    await prepareCharacterArt(content, sheets, raceId, gear);
    if (token !== this.token) return;
    const race = content.get('race', raceId);
    const layout = content.get('spriteLayout', race.spriteLayout);
    this.view.setLayer('body', sheets.get(race.sheet, layout, resolveColors(race, colors)));
    for (const slot of ARMOR_SLOTS) {
      const def = gear[slot] && content.tryGet('armor', gear[slot]!.defId);
      this.view.setLayer(slot, def ? sheets.get(armorSheetSrc(content, def), layout, { secondary: def.dye }) : null);
    }
    this.raceId = raceId;
    this.view.root.visible = true;
  }

  /** Screen position in device pixels (feet), and whole-number scale. */
  place(x: number, y: number, scale: number): void {
    this.view.root.position.set(Math.round(x), Math.round(y));
    this.view.root.scale.set(scale);
  }

  update(dt: number): void {
    this.time += dt;
  }

  render(): void {
    if (!this.raceId) return;
    const { content } = this.game;
    const layout = content.get('spriteLayout', content.get('race', this.raceId).spriteLayout);
    const anim = layout.animations.find((a) => a.id === this.anim) ?? layout.animations[0]!;
    this.view.setFrame(anim.id, this.dir, Math.floor(this.time * anim.fps));
  }

  destroy(): void {
    this.token++;
    this.view.destroy();
  }
}
