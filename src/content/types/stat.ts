import type { ContentTypeSpec } from '../Registry';
import { v, type Validator } from '../schema';
import type { StatDef } from '../../stats/Stats';

declare module '../Registry' {
  interface ContentMap {
    stat: StatDef;
  }
}

const schema: Validator<StatDef> = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string()),
  default: v.number(),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  format: v.optional(v.literal('int', 'percent', 'float')),
  scalesWithCondition: v.optional(v.boolean()),
});

export const statType: ContentTypeSpec<'stat'> = {
  type: 'stat',
  schema,
  crossCheck(def, ctx) {
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) ctx.error('min > max');
  },
};
