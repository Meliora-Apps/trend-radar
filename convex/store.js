// Citiri/scrieri mici pentru calculul zilei (process.js ruleaza in Node si nu atinge baza direct).
// Un singur calcul odata si reluarea pasilor: vezi calc.js.
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

const stateOf = (ctx, name) => ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', name)).unique();

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

// Fisierele unei tari (pentru baza ei, in process.js), in pagini.
export const rawCountryPage = internalQuery({
  args: { country: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { country, cursor }) => {
    const page = await ctx.db.query('raw').withIndex('by_country', (q) => q.eq('country', country)).paginate({ numItems: 1000, cursor });
    return { rows: page.page.map(({ kind, date, storageId, size }) => ({ kind, date, country, storageId, size })), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const rawOf = internalQuery({
  args: { kind: v.string(), date: v.string(), country: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.query('raw').withIndex('by_kind_date_country', (q) => q.eq('kind', a.kind).eq('date', a.date).eq('country', a.country)).unique();
    return r ? { storageId: r.storageId, size: r.size } : null;
  },
});

// Unealta manuala: linii in jurnalul unei zile (ex. dupa un calcul facut cu src/export/remote-calc.js).
//   npx convex run --prod store:note '{"date":"2026-11-09","log":["calculat si publicat de pe Mac (remote-calc.js)"]}'
export const note = internalMutation({
  args: { date: v.string(), log: v.array(v.string()) },
  handler: async (ctx, { date, log }) => {
    const run = await ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
    if (run) await ctx.db.patch(run._id, { log: [...run.log, ...log].slice(-300) });
  },
});

// ---- curatenie: fisierele din storage la care nu mai trimite nimic ----
// O actiune oprita fortat (memorie, timp) intre incarcarea unui fisier si inregistrarea lui il lasa in storage fara
// nicio trimitere, iar Convex nu le sterge singur. O data pe zi (cron) le sterg pe cele mai vechi de o zi: cele noi
// pot fi inca in lucru (un fisier se inregistreaza la cateva minute dupa incarcare, nu mai tarziu).
const SWEEP_MIN_AGE_MS = 24 * 3600_000;
// Toate trimiterile catre storage, pe tabele (vezi schema.js).
const REFS = {
  files: (d) => [d.storageId],
  raw: (d) => [d.storageId],
  pieces: (d) => [d.storageId],
  state: (d) => d.storageIds ?? [],
  jobs: (d) => [...d.parts.map((p) => p.storageId), ...(d.prepId ? [d.prepId] : [])],
};

export const refsPage = internalQuery({
  args: { table: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    if (!REFS[table]) throw new Error(`tabel necunoscut: ${table}`);
    const page = await ctx.db.query(table).paginate({ numItems: 1000, cursor });
    return { ids: page.page.flatMap(REFS[table]), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const storagePage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), before: v.number() },
  handler: async (ctx, { cursor, before }) => {
    const page = await ctx.db.system.query('_storage').paginate({ numItems: 1000, cursor });
    return { ids: page.page.filter((f) => f._creationTime < before).map((f) => f._id), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const dropStorage = internalMutation({
  args: { ids: v.array(v.id('_storage')) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
  },
});

// npx convex run --prod store:sweep (implicit din cron, zilnic).
export const sweep = internalAction({
  args: { minAgeMs: v.optional(v.number()) },
  handler: async (ctx, { minAgeMs = SWEEP_MIN_AGE_MS }) => {
    const before = Date.now() - minAgeMs;
    const used = new Set();
    for (const table of Object.keys(REFS)) {
      let cursor = null;
      do {
        const page = await ctx.runQuery(internal.store.refsPage, { table, cursor });
        for (const id of page.ids) used.add(id);
        cursor = page.cursor;
      } while (cursor);
    }
    const orphans = [];
    let cursor = null;
    do {
      const page = await ctx.runQuery(internal.store.storagePage, { cursor, before });
      orphans.push(...page.ids.filter((id) => !used.has(id)));
      cursor = page.cursor;
    } while (cursor);
    for (let i = 0; i < orphans.length; i += 100) await ctx.runMutation(internal.store.dropStorage, { ids: orphans.slice(i, i + 100) });
    console.log(`curatenie: ${orphans.length} fisiere fara trimitere, sterse (${used.size} folosite)`);
    return orphans.length;
  },
});
