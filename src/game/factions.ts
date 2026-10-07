import type { ContentRegistry } from '../content/Registry';
import type { Attitude } from '../content/types/faction';
import type { Entity, World } from '../ecs/World';
import { Creature, Faction, Npc } from './components';

/** Faction id used for the player character (their real side is `affiliation`). */
export const PLAYER_FACTION = 'player';
/** Reputation thresholds: at or below → the faction turns hostile; at or above → friendly. */
export const REP_HOSTILE = -40;
export const REP_FRIENDLY = 40;
/** Reputation lost for hurting / killing a member of a non-hostile faction. */
export const REP_HIT = -5;
export const REP_KILL = -30;

/** The player's standing, stored in the save (`flags.standing`). */
export interface PlayerStanding {
  affiliation: string;
  reputation: Record<string, number>;
}

export const defaultStanding = (): PlayerStanding => ({ affiliation: 'loners', reputation: {} });

const rank: Record<Attitude, number> = { hostile: 0, neutral: 1, friendly: 2 };

/**
 * Who is hostile to whom. Three layers, strongest last:
 * 1. Faction table: hostile if either side says hostile, friendly only if both do.
 * 2. The player: their affiliation's attitudes, shifted by personal reputation.
 * 3. Grudges: anyone who attacked an NPC (or its squad) is hostile to it.
 */
export class Relations {
  /** Called when the player's reputation changes a faction's attitude toward them. */
  onAttitudeChange: ((faction: string, attitude: Attitude) => void) | null = null;

  constructor(
    private content: ContentRegistry,
    readonly standing: PlayerStanding,
  ) {}

  factionAttitude(a: string, b: string): Attitude {
    if (a === b) return 'friendly';
    if (a === PLAYER_FACTION) return this.playerAttitude(b);
    if (b === PLAYER_FACTION) return this.playerAttitude(a);
    const fa = this.content.tryGet('faction', a);
    const fb = this.content.tryGet('faction', b);
    const ab = fa ? (fa.relations[b] ?? fa.defaultAttitude) : 'neutral';
    const ba = fb ? (fb.relations[a] ?? fb.defaultAttitude) : 'neutral';
    return rank[ab] <= rank[ba] ? ab : ba;
  }

  /** How a faction regards the player. */
  playerAttitude(faction: string): Attitude {
    const base: Attitude = faction === this.standing.affiliation ? 'friendly' : this.factionAttitude(this.standing.affiliation, faction);
    const rep = this.standing.reputation[faction] ?? 0;
    if (rep <= REP_HOSTILE) return 'hostile';
    if (rep >= REP_FRIENDLY && base === 'neutral') return 'friendly';
    if (rep < 0 && base === 'friendly' && rep <= REP_HOSTILE / 2) return 'neutral';
    return base;
  }

  attitude(world: World, a: Entity, b: Entity): Attitude {
    if (a === b) return 'friendly';
    if (world.get(a, Npc)?.grudges.has(b) || world.get(b, Npc)?.grudges.has(a)) return 'hostile';
    if (world.get(a, Creature)?.grudges.has(b) || world.get(b, Creature)?.grudges.has(a)) return 'hostile';
    const fa = world.get(a, Faction)?.id;
    const fb = world.get(b, Faction)?.id;
    if (!fa || !fb) return 'neutral';
    return this.factionAttitude(fa, fb);
  }

  hostile(world: World, a: Entity, b: Entity): boolean {
    return this.attitude(world, a, b) === 'hostile';
  }

  /** The player hurt or killed someone not already hostile to them: reputation drops. Returns the new value. */
  playerAggression(faction: string, killed: boolean): number {
    if (faction === PLAYER_FACTION) return 0;
    const before = this.playerAttitude(faction);
    const rep = (this.standing.reputation[faction] ?? 0) + (killed ? REP_KILL : REP_HIT);
    this.standing.reputation[faction] = Math.max(-100, rep);
    const after = this.playerAttitude(faction);
    if (after !== before) this.onAttitudeChange?.(faction, after);
    return this.standing.reputation[faction]!;
  }
}
