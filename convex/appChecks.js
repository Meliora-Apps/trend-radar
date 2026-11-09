// Ultima verificare "Verifica acum" a unui app (salvata ca s-o vezi la revenire si sa compari).
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { allowedEmail, requireAllowed } from './access';

const result = v.object({ term: v.string(), position: v.union(v.number(), v.null()), total: v.number() });

export const last = query({
  args: { appId: v.number(), country: v.string() },
  handler: async (ctx, { appId, country }) => {
    if (!(await allowedEmail(ctx))) return null;
    return ctx.db.query('appChecks').withIndex('by_app_country', (q) => q.eq('appId', appId).eq('country', country)).unique();
  },
});

export const save = mutation({
  args: { appId: v.number(), country: v.string(), results: v.array(result) },
  handler: async (ctx, { appId, country, results }) => {
    await requireAllowed(ctx);
    const row = await ctx.db.query('appChecks').withIndex('by_app_country', (q) => q.eq('appId', appId).eq('country', country)).unique();
    const doc = { appId, country, at: Date.now(), results: results.slice(0, 200) };
    if (row) await ctx.db.replace(row._id, doc);
    else await ctx.db.insert('appChecks', doc);
  },
});
