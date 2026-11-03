// Citiri/scrieri mici pentru calculul zilei (process.js ruleaza in Node si nu atinge baza direct).
import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

const PROCESS_LEASE_MS = 12 * 60_000;
const stateOf = (ctx, name) => ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', name)).unique();

// Un singur calcul odata (si din colectare, si din incarcarile manuale). Continuarile aceluiasi calcul
// (acelasi token) prelungesc rezervarea.
export const claimProcess = internalMutation({
  args: { date: v.string(), token: v.string() },
  handler: async (ctx, { date, token }) => {
    const now = Date.now();
    const lock = await stateOf(ctx, 'process');
    if (lock && lock.value?.until > now && lock.value?.token !== token) return false;
    const value = { until: now + PROCESS_LEASE_MS, date, token };
    if (lock) await ctx.db.patch(lock._id, { value, at: new Date(now).toISOString() });
    else await ctx.db.insert('state', { name: 'process', value, at: new Date(now).toISOString() });
    const run = await ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
    if (run) await ctx.db.patch(run._id, { lease: now + PROCESS_LEASE_MS });
    return true;
  },
});

export const releaseProcess = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const lock = await stateOf(ctx, 'process');
    if (lock && lock.value?.token === token) await ctx.db.patch(lock._id, { value: { until: 0 } });
  },
});

// Jurnalul zilei (pentru o continuare: ziua nu e inca gata).
export const note = internalMutation({
  args: { date: v.string(), log: v.array(v.string()) },
  handler: async (ctx, { date, log }) => {
    const run = await ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
    if (run) await ctx.db.patch(run._id, { log: [...run.log, ...log].slice(-300) });
  },
});

export const getState = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const s = await stateOf(ctx, name);
    return s ? { storageIds: s.storageIds ?? [], value: s.value ?? null, at: s.at } : null;
  },
});

// Inlocuieste o stare (si sterge fisierele vechi ale ei).
export const setState = internalMutation({
  args: { name: v.string(), storageIds: v.optional(v.array(v.id('_storage'))), value: v.optional(v.any()) },
  handler: async (ctx, { name, storageIds, value }) => {
    const at = new Date().toISOString();
    const s = await stateOf(ctx, name);
    if (!s) return ctx.db.insert('state', { name, at, storageIds, value });
    for (const id of s.storageIds ?? []) if (!storageIds?.includes(id)) await ctx.storage.delete(id);
    await ctx.db.patch(s._id, { at, storageIds, value });
  },
});

// Arhiva: un fisier zilnic nou sau inlocuit.
export const saveRaw = internalMutation({
  args: { kind: v.string(), date: v.string(), country: v.string(), storageId: v.id('_storage'), size: v.number() },
  handler: async (ctx, a) => {
    const old = await ctx.db.query('raw').withIndex('by_kind_date_country', (q) => q.eq('kind', a.kind).eq('date', a.date).eq('country', a.country)).unique();
    if (old) { await ctx.storage.delete(old.storageId); await ctx.db.delete(old._id); }
    await ctx.db.insert('raw', a);
  },
});

export const rawPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('raw').paginate({ numItems: 1000, cursor });
    return { rows: page.page.map(({ kind, date, country, storageId, size }) => ({ kind, date, country, storageId, size })), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const rawOf = internalQuery({
  args: { kind: v.string(), date: v.string(), country: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.query('raw').withIndex('by_kind_date_country', (q) => q.eq('kind', a.kind).eq('date', a.date).eq('country', a.country)).unique();
    return r ? { storageId: r.storageId, size: r.size } : null;
  },
});
