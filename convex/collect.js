// Colectarea zilnica, in Convex: cele 6 tari in paralel, fiecare pe doua benzi (cuvintele si app-urile, vezi
// LANES in src/collect/worker.js), pe bucati de ~4 minute (o actiune are max 10 minute si 64 MB). Starea fiecarei
// benzi e in tabela `jobs`, bucatile culese in fisiere JSON; la final process.js face din ele fisierele zilei,
// actualizeaza bazele tarilor si publica exportul pentru site (calculul pe pasi: calc.js).
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { COUNTRIES, makeAppleClient } from '../src/apple/clients.js';
import { makePacer, makeRetry } from '../src/apple/net.js';
import { LANES, newJob, phaseItems, preparePhase, work } from '../src/collect/worker.js';
import { todayUTC } from '../src/util/dates.js';

const TICK_MS = 4 * 60_000; // o bucata de lucru (plus reincercarile in curs: max ~2 min)
const LEASE_MS = 9 * 60_000; // cat timp o bucata are colectarea "rezervata"
const MAX_TICKS = 300; // peste atat (~20 ore), ceva e gresit: ziua se marcheaza esuata
const LOG_MAX = 300;
const MAX_ATTEMPTS = 4;
// Convex nu reia singur o actiune programata care cade inainte sa porneasca (eroare a platformei): la atat dupa
// fiecare predare (bucata urmatoare, calculul), `kick` verifica daca a pornit, fara sa astepte paznicul (10 min).
const START_GRACE_MS = 2 * 60_000;
// Faza in care trebuie pregatita o lista (vezi preparePhase) si ce bucati ii trebuie (din aceeasi banda).
const PREP_NEEDS = { expand: [], lookup: ['charts', 'feed'], upcoming: [], classify: ['base', 'expand'] };
// Ritmul cererilor catre Apple, comun tuturor benzilor dintr-o bucata (ies prin aceeasi adresa IP, iar Apple
// limiteaza pe adresa): [cel mai des, cel mai rar] in ms intre doua cereri ale serviciului. Vechiul ritm era
// pe tara (o cerere hints/RSS la 1,2 s si una search/lookup la 4 s in fiecare tara, adica ~5 si ~1,5 pe secunda
// in total), iar la un 429 tara astepta 15 + 30 + 60 s. Acum ritmul porneste de la cel atins in bucata
// anterioara (run.pace) si se aseaza singur sub limita Apple (vezi makePacer).
// Cautarea iTunes are limita Apple de ~20 de cereri pe minut de pe o adresa (peste ea: 429/403): ~19 pe minut,
// adica o cerere la 3,2 s (probat din Convex pe 9 nov: 1 flux la 3 s = 45/45 OK; 6 fluxuri la 4 s = 429/403 dupa
// ~48 de cereri). Un 403 o incetineste cel mult pana la o cerere la 6 s (+ pauza comuna): mai rar nu ajuta, iar
// revenirea (-2% la raspuns) ar dura prea mult. Cand Apple refuza tot (adresa blocata), pasii cu cautare se opresc
// (SEARCH_BLOCKED_* in worker.js).
const PACE = { hints: [200, 2000], rss: [200, 2000], lookup: [667, 4000], search: [3200, 6000] };
const PAUSE_MS = 20_000;
// Pasii cu cautare (clasificarea, precomenzile) se incheie la atat dupa pornirea colectarii (vezi SEARCH_MIN_MS
// in src/collect/worker.js), ca ziua sa fie gata in ~30 de minute; restul pasilor merg pana la capat.
const SEARCH_WINDOW_MS = 30 * 60_000;

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
    const now = Date.now();
    await ctx.db.insert('runs', { date, status: 'collecting', startedAt: now, lease: 0, ticks: 0, log: [] });
    for (const cc of COUNTRIES) {
      for (const lane of Object.keys(LANES)) {
        const job = { ...newJob(cc, date, lane), searchUntil: now + SEARCH_WINDOW_MS, ...(smoke ? { smoke: true } : {}) };
        await ctx.db.insert('jobs', { date, country: cc, job, parts: [] });
      }
    }
    await handOff(ctx, date, internal.collect.tick);
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
    const jobs = (await jobsOf(ctx, date)).map((j) => ({ id: j._id, job: j.job, prepId: j.prepId ?? null, parts: j.parts, planId: plans[j.country] }));
    return { jobs, pace: run.pace ?? null, searchGate: run.searchGate ?? null };
  },
});

const loadJson = async (ctx, id) => {
  const blob = await ctx.storage.get(id);
  return blob ? JSON.parse(await blob.text()) : null;
};
const storeJson = (ctx, obj) => ctx.storage.store(new Blob([JSON.stringify(obj)], { type: 'application/json' }));

// Banda unei tari in bucata curenta: continua pasul ei si trece la urmatorii, pana la `deadline`. Lista unui pas
// (preparePhase) se face la intrarea in el, din plan si din bucatile culese deja de banda (si in bucata aceasta).
// Intoarce starea noua, bucatile culese acum, lista pasului curent si listele de sters.
async function runLane(ctx, j, { deadline, log, pacers, retry, gate }) {
  let job = j.job;
  let prepId = j.prepId;
  const parts = [...j.parts];
  const added = [];
  const dropped = [];
  const apple = makeAppleClient({ pacers, retry });
  while (job.phase !== 'done' && Date.now() < deadline) {
    const phase = job.phase;
    const needs = PREP_NEEDS[phase];
    let prep = null;
    if (needs && !job.prepared) {
      const plan = j.planId ? await loadJson(ctx, j.planId) : null;
      const got = {};
      for (const p of parts.filter((x) => needs.includes(x.phase))) (got[p.phase] ??= []).push(...await loadJson(ctx, p.storageId));
      prep = preparePhase(job, { plan, parts: got });
      if (prepId) dropped.push(prepId);
      prepId = await storeJson(ctx, prep);
      job = { ...job, prepared: true };
      log(`[${job.country}] ${phase}: ${Array.isArray(prep) ? prep.length : prep.ids.length} de facut`);
    } else if (needs && prepId) {
      prep = await loadJson(ctx, prepId);
    }
    const r = await work(job, { apple, items: phaseItems(job, prep), prep, deadline, log, gate });
    if (r.out.length) {
      const part = { phase, storageId: await storeJson(ctx, r.out) };
      parts.push(part);
      added.push(part);
    }
    job = r.job;
    if (job.phase === phase) break; // timpul bucatii s-a terminat in mijlocul pasului
    log(`[${job.country}] ${phase} gata (${job.requests} cereri, ${job.failures} erori)`);
    job = { ...job, prepared: false };
    if (prepId) dropped.push(prepId);
    prepId = null;
  }
  return { id: j.id, job, added, prepId, dropped };
}

export const tick = internalAction({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const claimed = await ctx.runMutation(internal.collect.claim, { date });
    if (!claimed) return;
    const { jobs } = claimed;
    const deadline = Date.now() + TICK_MS;
    const logs = [];
    const log = (m) => { console.log(m); if (logs.length < 60) logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`); };

    // Tarile si benzile lor lucreaza in paralel, cu ritmuri comune pe servicii (o singura adresa IP). O banda care
    // termina un pas trece direct la urmatorul (nu asteapta sfarsitul bucatii).
    const pacers = Object.fromEntries(Object.entries(PACE).map(([k, [min, max]]) => [k, makePacer(min, { maxMs: max, pauseMs: PAUSE_MS, startMs: claimed.pace?.[k], until: deadline })]));
    const retry = makeRetry({ retries: 4, baseDelayMs: 5_000, rateLimitDelayMs: 0, log });
    const gate = { denied: 0, ...claimed.searchGate }; // 403 la rand la cautare, in toate benzile (SEARCH_BLOCKED_SHARED)
    const updates = await Promise.all(jobs.filter((j) => j.job.phase !== 'done').map((j) => runLane(ctx, j, { deadline, log, pacers, retry, gate })));
    const pace = Object.fromEntries(Object.entries(pacers).map(([k, p]) => [k, p.stats().intervalMs]));
    log(`ritm: ${Object.entries(pacers).map(([k, p]) => { const s = p.stats(); return `${k} ${s.intervalMs} ms${s.pauses ? ` (${s.pauses} pauze dupa 429)` : ''}`; }).join(', ')}`);

    // Salvare + urmatoarea bucata (sau calculul zilei, cand toate tarile au terminat), in aceeasi mutatie.
    const searchGate = { denied: gate.denied, ...(gate.at != null ? { at: gate.at } : {}) };
    await ctx.runMutation(internal.collect.progress, { date, updates, pace, searchGate, log: logs });
  },
});

// Urmatoarea actiune a zilei (o bucata de colectare sau calculul) + verificarea ca a pornit (kick).
async function handOff(ctx, date, fn) {
  await ctx.scheduler.runAfter(0, fn, { date });
  await ctx.scheduler.runAfter(START_GRACE_MS, internal.collect.kick, { date });
}

// O actiune predata (handOff) care n-a pornit: ziua nu e rezervata (lease), deci o programez din nou (o data;
// apoi o reia paznicul).
export const kick = internalMutation({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const run = await runOf(ctx, date);
    if (!run || run.lease > Date.now() || !['collecting', 'processing'].includes(run.status)) return;
    await ctx.scheduler.runAfter(0, run.status === 'collecting' ? internal.collect.tick : internal.process.run, { date });
    await ctx.db.patch(run._id, { log: [...run.log, `${new Date().toISOString().slice(11, 19)} ${run.status}: nimic nu lucreaza la zi (actiunea n-a pornit sau astepta alt calcul), o reiau`].slice(-LOG_MAX) });
  },
});

export const progress = internalMutation({
  args: {
    date: v.string(),
    updates: v.array(v.object({
      id: v.id('jobs'),
      job: v.any(),
      added: v.array(v.object({ phase: v.string(), storageId: v.id('_storage') })),
      prepId: v.union(v.id('_storage'), v.null()),
      dropped: v.array(v.id('_storage')),
    })),
    pace: v.optional(v.any()),
    searchGate: v.optional(v.object({ denied: v.number(), at: v.optional(v.number()) })),
    log: v.array(v.string()),
  },
  handler: async (ctx, { date, updates, pace, searchGate, log }) => {
    for (const u of updates) {
      const j = await ctx.db.get(u.id);
      for (const id of u.dropped) await ctx.storage.delete(id);
      await ctx.db.patch(u.id, { job: u.job, parts: [...j.parts, ...u.added], prepId: u.prepId ?? undefined });
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
      lease: 0, log: [...run.log, ...log].slice(-LOG_MAX), ...(pace ? { pace } : {}), ...(searchGate ? { searchGate } : {}),
      ...(smoke ? { status: 'done', finishedAt: Date.now() } : done ? { status: 'processing' } : {}),
    });
    if (!smoke) await handOff(ctx, date, done ? internal.process.run : internal.collect.tick);
  },
});

// Paznicul (cron la 10 minute): daca o bucata a cazut (eroare, timp depasit), reia colectarea sau calculul
// (un calcul in lucru cu pasi opriti sau pierduti: calc.watch).
export const watchdog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    if (await ctx.db.query('calcs').withIndex('by_status', (q) => q.eq('status', 'running')).first()) {
      await ctx.scheduler.runAfter(0, internal.calc.watch, {});
    }
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

// Pentru process.js: bucatile culese ale zilei (doar o tara, cu `country`), cate un rand pe banda.
export const dayJobs = internalQuery({
  args: { date: v.string(), country: v.optional(v.string()) },
  handler: async (ctx, { date, country }) => {
    // Doar o colectare terminata (toate tarile gata); o incarcare manuala in timpul colectarii n-o atinge.
    const run = await runOf(ctx, date);
    if (!run || run.status === 'collecting') return [];
    const rows = await ctx.db.query('jobs').withIndex('by_date_country', (q) => (country ? q.eq('date', date).eq('country', country) : q.eq('date', date))).collect();
    return rows.map((j) => ({ country: j.country, job: j.job, parts: j.parts }));
  },
});

// Ziua e gata: sterge bucatile (raman fisierele zilei in `raw`). Folosit si de calc.js (publicarea).
export async function finishRun(ctx, { date, status, error, log }) {
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
}

export const finish = internalMutation({
  args: { date: v.string(), status: v.string(), error: v.optional(v.string()), log: v.array(v.string()) },
  handler: (ctx, a) => finishRun(ctx, a),
});
