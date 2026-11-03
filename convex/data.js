// Fisierele exportului zilnic: browserul cere cheia, primeste un link de descarcare (doar daca are acces).
import { query, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireAllowed, allowedEmail } from './access';

const current = (ctx) => ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', 'current')).unique();

export const me = query({
  args: {},
  handler: async (ctx) => {
    const email = await allowedEmail(ctx);
    const cur = email ? await current(ctx) : null;
    return { email, gen: cur?.gen ?? null, at: cur?.at ?? null };
  },
});

// Mai multe chei deodata (o pagina are nevoie de 1-3 fisiere). null = fisier inexistent.
export const urls = query({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, { keys }) => {
    await requireAllowed(ctx);
    const cur = await current(ctx);
    if (!cur) return { gen: null, urls: keys.map(() => null) };
    const out = [];
    for (const key of keys.slice(0, 20)) {
      const f = await ctx.db.query('files').withIndex('by_gen_key', (q) => q.eq('gen', cur.gen).eq('key', key)).unique();
      out.push(f ? await ctx.storage.getUrl(f.storageId) : null);
    }
    return { gen: cur.gen, urls: out };
  },
});

// ---- scrise doar de calculul zilnic (process.js) ----

export const addFiles = internalMutation({
  args: { gen: v.string(), files: v.array(v.object({ key: v.string(), storageId: v.id('_storage') })) },
  handler: async (ctx, { gen, files }) => {
    for (const f of files) {
      const old = await ctx.db.query('files').withIndex('by_gen_key', (q) => q.eq('gen', gen).eq('key', f.key)).unique();
      if (old) { await ctx.storage.delete(old.storageId); await ctx.db.delete(old._id); }
      await ctx.db.insert('files', { gen, ...f });
    }
  },
});

// Trece pe generatia noua, apoi sterge (in loturi) fisierele generatiilor vechi.
export const commit = internalMutation({
  args: { gen: v.string() },
  handler: async (ctx, { gen }) => {
    // Generatia trebuie sa aiba toate fisierele de baza (meta + listele + cuvintele); altfel exportul e rupt.
    const n = (await ctx.db.query('files').withIndex('by_gen_key', (q) => q.eq('gen', gen)).collect()).length;
    for (const key of ['meta', 'terms', 'term/0', 'app/0']) {
      if (!await ctx.db.query('files').withIndex('by_gen_key', (q) => q.eq('gen', gen).eq('key', key)).unique()) throw new Error(`generatia ${gen} n-are ${key}`);
    }
    const cur = await current(ctx);
    const at = new Date().toISOString();
    if (cur) await ctx.db.patch(cur._id, { gen, at }); else await ctx.db.insert('state', { name: 'current', gen, at });
    await ctx.scheduler.runAfter(0, internal.data.cleanup, { keep: gen });
    return n;
  },
});

// Parcurge toate fisierele in pagini si sterge tot ce nu e din generatia `keep` (si incarcarile neterminate).
export const cleanup = internalMutation({
  args: { keep: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { keep, cursor = null }) => {
    const page = await ctx.db.query('files').paginate({ numItems: 300, cursor });
    for (const f of page.page) {
      if (f.gen === keep) continue;
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.data.cleanup, { keep, cursor: page.continueCursor });
  },
});
