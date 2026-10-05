import type { Direction } from '../core/math';
import { deriveSeed, hashString, Rng } from '../core/rng';
import type { ContentRegistry } from '../content/Registry';
import type { Entity, World } from '../ecs/World';
import type { ChannelColors } from '../render/palette';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave, EquipmentSlot, ItemInstance } from '../save/types';
import { chunkKey, type WorldDeltas } from '../save/WorldDeltas';
import { addCombatComponents, prepareCharacterArt, spawnCharacter } from './characters';
import { Brain, Character, Container, Equipment, Faction, Health, Inventory, Npc, Transform, View, newBrain } from './components';
import { addItem } from './items';
import { generateFromTemplate } from './npcs';
import { nearestWalkable } from './ai/pathfinding';
import type { CampSpawn } from './world/generators';
import { TILE_PX, type TileMap } from './world/TileMap';

/** Chunk-delta key holding the ids of generated NPCs that died (they stay dead). */
export const POPULATION_KEY = 'population';
/** World entity record kind for a corpse (data: BodyData). */
export const BODY_KIND = 'body';

/** What a saved corpse needs to be drawn and searched again. */
export interface BodyData {
  name: string;
  faction: string;
  raceId: string;
  colors: ChannelColors;
  facing: Direction;
  /** Worn gear still on the body, by slot → uid of an entry in `items`. */
  worn: Partial<Record<EquipmentSlot, string>>;
  items: ItemInstance[];
}

export interface SpawnNpcOptions {
  id: string;
  campId: string;
  templateId: string;
  x: number;
  y: number;
  behavior: 'guard' | 'patrol';
  /** Camp center (defaults to the spawn point) and how far guards wander from it. */
  homeX?: number;
  homeY?: number;
  radius: number;
  waypoints?: { x: number; y: number }[];
  rng: Rng;
}

/**
 * Who lives in a world: camps of NPCs generated from the world seed (the same
 * people every visit, minus the ones who died), and the bodies left behind.
 * Bodies are saved as world entity records, so their remaining loot persists.
 */
export class Population {
  constructor(
    private world: World,
    private content: ContentRegistry,
    private sheets: SpriteSheetCache,
    private deltas: WorldDeltas,
    private map: TileMap,
    /** Adds a new character's view to the scene. */
    private show: (e: Entity) => void,
  ) {}

  isDead(npcId: string): boolean {
    return this.deltas.get(POPULATION_KEY)?.removed.includes(npcId) ?? false;
  }

  /** Spawns every living member of every camp. Loadouts come from the world seed, so they're stable. */
  async spawnCamps(camps: CampSpawn[], seed: number): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const camp of camps) {
      for (let i = 0; i < camp.templates.length; i++) {
        const id = `${camp.id}:${i}`;
        if (this.isDead(id)) continue;
        const rng = new Rng(deriveSeed(seed, 'npc', hashString(id)));
        const spot = this.spotNear(camp.x, camp.y, camp.radius, rng);
        if (!spot) continue;
        out.push(
          await this.spawnNpc({
            id,
            campId: camp.id,
            templateId: camp.templates[i]!,
            x: spot.x,
            y: spot.y,
            behavior: camp.behavior,
            homeX: camp.x,
            homeY: camp.y,
            radius: camp.radius,
            waypoints: camp.waypoints,
            rng,
          }),
        );
      }
    }
    return out;
  }

  async spawnNpc(o: SpawnNpcOptions): Promise<Entity> {
    const template = this.content.get('npcTemplate', o.templateId);
    const loadout = generateFromTemplate(this.content, o.rng, template);
    await prepareCharacterArt(this.content, this.sheets, loadout.raceId, loadout.equipment);
    const e = spawnCharacter(this.world, this.content, this.sheets, {
      raceId: loadout.raceId,
      colors: loadout.colors,
      equipment: loadout.equipment,
      x: o.x,
      y: o.y,
      facing: o.rng.pick(['down', 'left', 'right', 'up'] as const),
    });
    addCombatComponents(this.world, e, { faction: template.faction, inventory: loadout.inventory });
    this.world.add(e, Npc, { id: o.id, campId: o.campId, templateId: template.id, name: loadout.name, skill: loadout.skill, grudges: new Set() });
    const brain = newBrain(o.behavior, o.homeX ?? o.x, o.homeY ?? o.y, o.radius, o.waypoints ?? []);
    brain.thinkIn = o.rng.range(0, 0.2); // stagger perception across NPCs
    this.world.add(e, Brain, brain);
    this.show(e);
    return e;
  }

  /** A walkable spot within `radius` of (x, y), world pixels. */
  spotNear(x: number, y: number, radius: number, rng: Rng): { x: number; y: number } | null {
    for (let i = 0; i < 30; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, radius);
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      const tx = Math.floor(px / TILE_PX);
      const ty = Math.floor(py / TILE_PX);
      if (!this.map.isSolid(tx, ty) && !this.map.isSolid(tx, ty - 1)) return { x: px, y: py };
    }
    const t = nearestWalkable(this.map, Math.floor(x / TILE_PX), Math.floor(y / TILE_PX), 6);
    return t ? { x: (t.x + 0.5) * TILE_PX, y: (t.y + 0.5) * TILE_PX } : null;
  }

  /**
   * An NPC died: it stays dead, and its body becomes a container holding
   * everything it had (worn gear knocked about a bit, weapons, pockets).
   */
  onNpcDeath(e: Entity): void {
    const npc = this.world.get(e, Npc);
    const eq = this.world.get(e, Equipment);
    if (!npc || !eq) return;
    this.deltas.markRemoved(POPULATION_KEY, npc.id);
    const items: ItemInstance[] = [];
    for (const it of Object.values(eq)) {
      if (!it) continue;
      it.condition = Math.round(it.condition * (0.55 + Math.random() * 0.4) * 100) / 100;
      items.push(it);
    }
    for (const it of this.world.get(e, Inventory) ?? []) addItem(this.content, items, it);
    const t = this.world.req(e, Transform);
    const S = this.map.chunkSize;
    this.world.add(e, Container, {
      id: `body:${npc.id}`,
      label: `${npc.name}'s body`,
      kind: 'body',
      chunkKey: chunkKey(Math.floor(t.x / TILE_PX / S), Math.floor(t.y / TILE_PX / S)),
      lootTable: null,
      items,
    });
    this.saveBody(e);
  }

  /** Writes a body's current state (what's left on it) into the world's saved changes. */
  saveBody(e: Entity): void {
    const c = this.world.get(e, Container);
    if (!c || c.kind !== 'body' || !c.chunkKey || !c.items) return;
    const t = this.world.req(e, Transform);
    const ch = this.world.req(e, Character);
    const eq = this.world.get(e, Equipment) ?? {};
    const worn: BodyData['worn'] = {};
    for (const [slot, it] of Object.entries(eq) as [EquipmentSlot, ItemInstance | undefined][]) {
      if (it && c.items.includes(it)) worn[slot] = it.uid;
    }
    const data: BodyData = {
      name: c.label.replace(/'s body$/, ''),
      faction: this.world.get(e, Faction)?.id ?? '',
      raceId: ch.raceId,
      colors: ch.colors,
      facing: ch.facing,
      worn,
      items: structuredClone(c.items),
    };
    this.deltas.putEntity(c.chunkKey, { id: c.id, kind: BODY_KIND, x: t.x, y: t.y, data });
  }

  /** Re-creates every saved body in this world. */
  async restoreBodies(): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const { key, record } of this.deltas.entitiesOfKind(BODY_KIND)) {
      const d = record.data as BodyData;
      if (!this.content.has('race', d.raceId)) continue;
      const items = structuredClone(d.items);
      const equipment: EquipmentSave = {};
      for (const [slot, uid] of Object.entries(d.worn) as [EquipmentSlot, string][]) {
        const it = items.find((i) => i.uid === uid);
        if (it && (slot === 'primary' || slot === 'sidearm' ? this.content.has('weapon', it.defId) : this.content.has('armor', it.defId))) {
          equipment[slot] = it;
        }
      }
      await prepareCharacterArt(this.content, this.sheets, d.raceId, equipment);
      const e = spawnCharacter(this.world, this.content, this.sheets, {
        raceId: d.raceId,
        colors: d.colors,
        equipment,
        x: record.x,
        y: record.y,
        facing: d.facing,
      });
      addCombatComponents(this.world, e, { faction: d.faction || 'none', active: null, hp: 0 });
      const h = this.world.req(e, Health);
      h.hp = 0;
      h.dead = true;
      this.world.add(e, Container, { id: record.id, label: `${d.name}'s body`, kind: 'body', chunkKey: key, lootTable: null, items });
      this.world.req(e, View).setDead(true);
      this.show(e);
      out.push(e);
    }
    return out;
  }
}
