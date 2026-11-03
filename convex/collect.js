// Colectarea zilnica, in Convex: cele 6 tari in paralel, pe bucati de ~4 minute (o actiune are max 10 minute
// si 64 MB). Starea fiecarei tari e in tabela `jobs`, bucatile culese in fisiere JSON; la final process.js
// face din ele fisierele zilei, actualizeaza baza de calcul si publica exportul pentru site.
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { COUNTRIES, makeAppleClient } from '../src/apple/clients.js';
import { makeRetry } from '../src/apple/net.js';
import { newJob, phaseItems, preparePhase, work } from '../src/collect/worker.js';
import { todayUTC } from '../src/util/dates.js';

const TICK_MS = 4 * 60_000; // o bucata de lucru (plus reincercarile in curs: max ~2 min)
const LEASE_MS = 9 * 60_000; // cat timp o bucata are colectarea "rezervata"
const MAX_TICKS = 300; // peste atat (~20 ore), ceva e gresit: ziua se marcheaza esuata
const LOG_MAX = 300;
const MAX_ATTEMPTS = 4;
// Faza in care trebuie pregatita o lista (vezi preparePhase) si ce bucati ii trebuie.
const PREP_NEEDS = { expand: [], lookup: ['charts', 'feed'], classify: ['base', 'expand'] };

const runOf = (ctx, date) => ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
const jobsOf = (ctx, date) => ctx.db.query('jobs').withIndex('by_date_country', (q) => q.eq('date', date)).collect();

// Porneste colectarea zilei (din cron). O zi deja pornita nu se reia, decat cu force (si atunci de la zero).
// Cron-ul porneste doar unde COLLECT_ENABLED=1 (productia); din terminal: manual=true (smoke = proba scurta).
export const start = internalMutation({
  args: { date: v.optional(v.string()), force: v.optional(v.boolean()), manual: v.optional(v.boolean()), smoke: v.optional(v.boolean()) },
  handler: async (ctx, { date = todayUTC(), force = false, manual = false, smoke = false }) => {
    if (!manual && process.env.COLLECT_ENABLED !== '1') return 'colectarea automata e oprita aici (COLLECT_ENABLED)';
    const run = await runOf(ctx, date);
    if (run && !force) return `ziua ${date} e deja ${run.status}`;
    if (run) {
      for (const j of await jobsOf(ctx, date)) {
        for (const p of j.parts) await ctx.storage.delete(p.storageId);
        if (j.prepId) await ctx.storage.delete(j.prepId);
        await ctx.db.delete(j._id);
      }
      await ctx.db.delete(run._id);
    }
    await ctx.db.insert('runs', { date, status: 'collecting', startedAt: Date.now(), lease: 0, ticks: 0, log: [] });
    for (const cc of COUNTRIES) await ctx.db.insert('jobs', { date, country: cc, job: { ...newJob(cc, date), ...(smoke ? { smoke: true } : {}) }, parts: [] });
    await ctx.scheduler.runAfter(0, internal.collect.tick, { date });
    return `ziua ${date} pornita`;
  },
});

// Rezerva urmatoarea bucata (doar una ruleaza odata) si intoarce starea tarilor.
export const claim = internalMutation({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const run = await runOf(ctx, date);
    const now = Date.now();
    if (!run || run.status !== 'collecting' || run.lease > now) return null;
    if (run.ticks >= MAX_TICKS) {
      await ctx.db.patch(run._id, { status: 'failed', error: `peste ${MAX_TICKS} bucati` });
      return null;
    }
    await ctx.db.patch(run._id, { lease: now + LEASE_MS, ticks: run.ticks + 1 });
    const plans = {};
    for (const cc of COUNTRIES) {
      const p = await ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', `plan/${cc}`)).unique();
      plans[cc] = p?.storageIds?.[0] ?? null;
    }
    return (await jobsOf(ctx, date)).map((j) => ({ id: j._id, job: j.job, prepId: j.prepId ?? null, parts: j.parts, planId: plans[j.country] }));
  },
});

const loadJson = async (ctx, id) => {
  const blob = await ctx.storage.get(id);
  return blob ? JSON.parse(await blob.text()) : null;
};
const storeJson = (ctx, obj) => ctx.storage.store(new Blob([JSON.stringify(obj)], { type: 'application/json' }));

export const tick = internalAction({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const jobs = await ctx.runMutation(internal.collect.claim, { date });
    if (!jobs) return;
    const deadline = Date.now() + TICK_MS;
    const logs = [];
    const log = (m) => { console.log(m); if (logs.length < 40) logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`); };

    // 1. La intrarea intr-o faza noua, lista ei (o tara pe rand: memoria e mica).
    const preps = [];
    for (const j of jobs) {
      const needs = PREP_NEEDS[j.job.phase];
      if (!needs || j.job.prepared) continue;
      const plan = j.planId ? await loadJson(ctx, j.planId) : null;
      const parts = {};
      for (const p of j.parts.filter((x) => needs.includes(x.phase))) (parts[p.phase] ??= []).push(...await loadJson(ctx, p.storageId));
      const prep = preparePhase(j.job, { plan, parts });
      j.prepId = await storeJson(ctx, prep);
      j.job = { ...j.job, prepared: true };
      preps.push({ id: j.id, prepId: j.prepId, job: j.job });
      log(`[${j.job.country}] ${j.job.phase}: ${Array.isArray(prep) ? prep.length : prep.ids.length} de facut`);
    }
    if (preps.length) await ctx.runMutation(internal.collect.savePrep, { preps });

    // 2. Tarile lucreaza in paralel, fiecare cu ritmul ei (ca pe calculatoare separate).
    const updates = await Promise.all(jobs.filter((j) => j.job.phase !== 'done').map(async (j) => {
      const prep = j.prepId ? await loadJson(ctx, j.prepId) : null;
      const apple = makeAppleClient({ retry: makeRetry({ retries: 3, baseDelayMs: 15_000, log }) });
      const phase = j.job.phase;
      const r = await work(j.job, { apple, items: phaseItems(j.job, prep), prep, deadline, log });
      const partId = r.out.length ? await storeJson(ctx, r.out) : null;
      const job = r.job.phase !== phase ? { ...r.job, prepared: false } : r.job;
      if (job.phase !== phase) log(`[${job.country}] ${phase} gata (${job.requests} cereri, ${job.failures} erori)`);
      return { id: j.id, job, phase, partId };
    }));

    // 3. Salvare + urmatoarea bucata (sau calculul zilei, cand toate tarile au terminat).
    const done = await ctx.runMutation(internal.collect.progress, { date, updates, log: logs });
    if (done) await ctx.scheduler.runAfter(0, internal.process.run, { date });
    else await ctx.scheduler.runAfter(0, internal.collect.tick, { date });
  },
});

export const savePrep = internalMutation({
  args: { preps: v.array(v.object({ id: v.id('jobs'), prepId: v.id('_storage'), job: v.any() })) },
  handler: async (ctx, { preps }) => {
    for (const p of preps) {
      const j = await ctx.db.get(p.id);
      if (j.prepId && j.prepId !== p.prepId) await ctx.storage.delete(j.prepId);
      await ctx.db.patch(p.id, { prepId: p.prepId, job: p.job });
    }
  },
});

export const progress = internalMutation({
  args: {
    date: v.string(),
    updates: v.array(v.object({ id: v.id('jobs'), job: v.any(), phase: v.string(), partId: v.union(v.id('_storage'), v.null()) })),
    log: v.array(v.string()),
  },
  handler: async (ctx, { date, updates, log }) => {
    for (const u of updates) {
      const j = await ctx.db.get(u.id);
      const patch = { job: u.job, parts: u.partId ? [...j.parts, { phase: u.phase, storageId: u.partId }] : j.parts };
      if (u.job.phase !== u.phase && j.prepId) {
        await ctx.storage.delete(j.prepId);
        patch.prepId = undefined;
      }
      await ctx.db.patch(u.id, patch);
    }
    const run = await runOf(ctx, date);
    const jobs = await jobsOf(ctx, date);
    const done = jobs.every((j) => j.job.phase === 'done');
    // O proba (smoke) doar arata ca merge: nu intra in arhiva si nu se calculeaza.
    const smoke = done && jobs.some((j) => j.job.smoke);
    if (smoke) {
      for (const j of jobs) {
        for (const p of j.parts) await ctx.storage.delete(p.storageId);
        if (j.prepId) await ctx.storage.delete(j.prepId);
        await ctx.db.patch(j._id, { parts: [], prepId: undefined });
      }
    }
    await ctx.db.patch(run._id, {
      lease: 0, log: [...run.log, ...log].slice(-LOG_MAX),
      ...(smoke ? { status: 'done', finishedAt: Date.now() } : done ? { status: 'processing' } : {}),
    });
    return done && !smoke;
  },
});

// Paznicul (cron la 10 minute): daca o bucata a cazut (eroare, timp depasit), reia colectarea sau calculul.
export const watchdog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const status of ['collecting', 'processing']) {
      for (const run of await ctx.db.query('runs').withIndex('by_status', (q) => q.eq('status', status)).collect()) {
        if (run.lease > now - 60_000) continue;
        if (status === 'collecting') await ctx.scheduler.runAfter(0, internal.collect.tick, { date: run.date });
        else await ctx.scheduler.runAfter(0, internal.process.run, { date: run.date });
        await ctx.db.patch(run._id, { log: [...run.log, `${new Date(now).toISOString().slice(11, 19)} paznic: reiau ${status}`].slice(-LOG_MAX) });
      }
    }
  },
});

// Pentru process.js: bucatile culese ale zilei, pe tari.
export const dayJobs = internalQuery({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    // Doar o colectare terminata (toate tarile gata); o incarcare manuala in timpul colectarii n-o atinge.
    const run = await runOf(ctx, date);
    if (run?.status !== 'processing') return [];
    return (await jobsOf(ctx, date)).map((j) => ({ country: j.country, job: j.job, parts: j.parts }));
  },
});

// Ziua e gata: sterge bucatile (raman fisierele zilei in `raw`).
export const finish = internalMutation({
  args: { date: v.string(), status: v.string(), error: v.optional(v.string()), log: v.array(v.string()) },
  handler: async (ctx, { date, status, error, log }) => {
    const run = await runOf(ctx, date);
    if (!run) return;
    if (status === 'done') {
      for (const j of await jobsOf(ctx, date)) {
        for (const p of j.parts) await ctx.storage.delete(p.storageId);
        if (j.prepId) await ctx.storage.delete(j.prepId);
        await ctx.db.patch(j._id, { parts: [], prepId: undefined });
      }
    }
    // Un calcul esuat se reia de paznic (status 'processing'), de cel mult MAX_ATTEMPTS ori.
    const attempts = (run.attempts ?? 0) + (error ? 1 : 0);
    await ctx.db.patch(run._id, {
      status: error && attempts >= MAX_ATTEMPTS ? 'failed' : status, attempts, lease: 0, finishedAt: Date.now(),
      ...(error ? { error } : {}), log: [...run.log, ...log].slice(-LOG_MAX),
    });
  },
});
