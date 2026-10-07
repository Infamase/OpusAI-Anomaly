import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkDrawing, legendEntry } from './legend';

declare module '../Registry' {
  interface ContentMap {
    room: RoomDef;
  }
}

/**
 * A piece of a station, ship or underground lab. Drawn like a structure, but
 * tiles can be theme slots ("$wall", "$floor"…) so the same room serves every
 * interior, and `door` cells on its outer wall are sockets: the interior
 * generator attaches other rooms there (a doorway) or seals them (wall).
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** What kind of room, for interiors to ask for ("corridor", "lab", "quarters"…). */
  tags: v.array(v.id(), { min: 1 }),
  legend: v.record(legendEntry),
  map: v.array(v.string(), { min: 1 }),
  rotate: v.optional(v.boolean(), true),
  /** Who lives here (rolled per copy with `chance`). */
  camp: v.optional(
    v.object({
      faction: v.id(),
      templates: v.array(v.id(), { min: 1 }),
      behavior: v.optional(v.literal('guard', 'patrol'), 'guard'),
      radius: v.optional(v.number({ min: 1 }), 4),
      chance: v.optional(v.number({ min: 0, max: 1 }), 1),
    }),
  ),
});

export type RoomDef = Infer<typeof schema>;

export const roomType: ContentTypeSpec<'room'> = {
  type: 'room',
  schema,
  crossCheck(def, ctx) {
    checkDrawing(def, ctx, { slots: true });
    // Sockets must sit on the outer edge, not on a corner.
    const w = def.map[0]?.length ?? 0;
    const h = def.map.length;
    let sockets = 0;
    def.map.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const e = def.legend[row[i]!];
        if (!e || typeof e === 'string' || !e.door) continue;
        sockets++;
        const edge = i === 0 || j === 0 || i === w - 1 || j === h - 1;
        const corner = (i === 0 || i === w - 1) && (j === 0 || j === h - 1);
        if (!edge || corner) ctx.error(`door socket at ${i},${j} must be on the outer wall, not a corner`);
      }
    });
    if (!sockets) ctx.error('needs at least one door socket');
    if (def.camp) {
      ctx.ref('faction', def.camp.faction, 'camp.faction');
      def.camp.templates.forEach((t, i) => ctx.ref('npcTemplate', t, `camp.templates[${i}]`));
    }
  },
};
