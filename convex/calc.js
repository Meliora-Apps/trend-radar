// Calculul zilei pe pasi (actiunile sunt in process.js). Intai cate un pas pe tara, toate in paralel: baza tarii
// (fisierele zilei, importul, planul de maine) si partea tarii din export. Apoi pasii comuni, tot in paralel: meta +
// lista cuvintelor, listele ALL (pe grupe), paginile cuvintelor si ale app-urilor (pe grupe). La final, publicarea.
// Fiecare pas e o actiune separata (Convex: max 10 minute si 512 MB pe actiune, disc temporar mic); intre pasi
// totul sta in fisiere (Convex storage): bazele tarilor (state db/<CC>), bucatile (tabela `pieces`), exportul.
// Aici e starea pasilor (tabela `calcs`). Un pas cazut (eroare) se reia singur, de cel mult STEP_ATTEMPTS ori.
// Unul oprit fortat (memorie, timp) nu mai apuca sa raporteze: il reia `check`, programat la fiecare pornire
// pentru clipa in care rezervarea pasului expira; ca plasa de siguranta, paznicul (collect.watchdog -> watch).
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { finishRun } from './collect';
import { commitGen } from './data';

// O actiune Node are max 10 minute: un pas mai vechi de atat sigur nu mai lucreaza.
const STEP_LEASE_MS = 10 * 60_000 + 30_000;
const STEP_ATTEMPTS = 3;
const RETRY_AFTER_MS = 20_000;
const WAITING_MS = 15 * 60_000; // un pas programat si nepornit de atata timp = pierdut (se reprogrameaza)
const STALE_MS = 30 * 60_000; // un calcul fara nicio miscare de atata timp = abandonat
const LOG_MAX = 300;
// Pasii porniti odata (22 de pasi comuni) isi scriu starea in acelasi document (calcs): pornirile se esaloneaza
// putin, ca mutatiile lor (claim, done) sa nu se ciocneasca toate deodata (OCC).
const STAGGER_MS = 150;
// Rezervarea zilei (runs.lease) se lungeste doar cand ar mai castiga atat: altfel fiecare pas pornit ar rescrie ziua.
const LEASE_SLACK_MS = 60_000;
// Convex nu reia singur o actiune programata care cade inainte sa porneasca (eroare a platformei): un pas inca
// nepornit la atat dupa ora lui se programeaza din nou (`check`, o data; apoi il reia paznicul, vezi WAITING_MS).
const START_GRACE_MS = 2 * 60_000;

const calcOf = (ctx, token) => ctx.db.query('calcs').withIndex('by_token', (q) => q.eq('token', token)).unique();
const running = (ctx) => ctx.db.query('calcs').withIndex('by_status', (q) => q.eq('status', 'running')).collect();
const runOf = (ctx, date) => ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
const stamp = () => new Date().toISOString().slice(11, 19);
const secs = (ms) => `${Math.round((ms ?? 0) / 1000)} s`;

const startStep = (ctx, calc, step, at = 0) => ctx.scheduler.runAfter(at,
  calc.steps[step].stage === 'country' ? internal.process.country : internal.process.merge, { token: calc.token, step });

function schedule(ctx, calc, names, delayMs = 0) {
  return Promise.all(names.flatMap((step, i) => {
    const at = delayMs + i * STAGGER_MS;
    return [
      startStep(ctx, calc, step, at),
      ctx.scheduler.runAfter(at + START_GRACE_MS, internal.calc.check, { token: calc.token, step, attempt: calc.steps[step].attempts }),
    ];
  }));
}

// Jurnalul zilei (tabela runs) si rezervarea ei: cat timp un pas lucreaza, paznicul nu reia ziua.
async function note(ctx, date, lines, leaseUntil = 0) {
  const run = await runOf(ctx, date);
  const extend = run && run.lease < leaseUntil - LEASE_SLACK_MS;
  if (!run || (!lines.length && !extend)) return;
  await ctx.db.patch(run._id, { log: [...run.log, ...lines].slice(-LOG_MAX), ...(extend ? { lease: leaseUntil } : {}) });
}

// Ziua din `runs` se inchide doar daca nu e inca in colectare (un calcul pornit manual in timpul colectarii,
// dupa o incarcare de fisiere, nu are voie sa-i stearga bucatile culese).
async function closeRun(ctx, date, args) {
  const run = await runOf(ctx, date);
  if (run?.status === 'collecting') return note(ctx, date, args.log);
  await finishRun(ctx, { date, ...args });
}

const stageOf = (c) => (Object.values(c.steps).some((s) => s.stage === 'country' && s.status !== 'done') ? 'country' : 'merge');
const allDone = (c) => Object.values(c.steps).every((s) => s.status === 'done');

// Pasii etapei curente care nu mai lucreaza nimeni: opriti fortat (rezervare expirata) sau programati si nepornit.
export function stuckSteps(c, now = Date.now()) {
  const stage = stageOf(c);
  return Object.entries(c.steps).filter(([, s]) => s.stage === stage && (
    (s.status === 'running' && s.lease < now) || (s.status === 'waiting' && (s.scheduledAt ?? 0) < now - WAITING_MS)
  )).map(([name]) => name);
}

async function failCalc(ctx, c, error) {
  await ctx.db.patch(c._id, { status: 'failed', error: error.slice(0, 500), finishedAt: Date.now(), updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.calc.dropPieces, { token: c.token });
  // Si dupa ce s-a oprit sigur orice pas inca in lucru (o actiune are max 10 minute): bucatile adaugate intre timp.
  await ctx.scheduler.runAfter(STEP_LEASE_MS, internal.calc.dropPieces, { token: c.token });
  // Ziua ramane 'processing' (o reia paznicul, cu un calcul nou), de cel mult MAX_ATTEMPTS ori (collect.js).
  await closeRun(ctx, c.date, { status: 'processing', error: error.slice(0, 500), log: [`${stamp()} EROARE calcul: ${error.slice(0, 300)}`] });
}

// Reprogrameaza pasii opriti (sau publicarea, daca toti pasii sunt gata).
async function resume(ctx, c, now, why) {
  if (allDone(c)) {
    await ctx.scheduler.runAfter(0, internal.calc.publish, { token: c.token });
    return ['publish'];
  }
  const stuck = stuckSteps(c, now);
  const over = stuck.find((name) => c.steps[name].status === 'running' && c.steps[name].attempts >= STEP_ATTEMPTS);
  if (over) {
    await failCalc(ctx, c, `${over}: ${c.steps[over].error ?? 'oprit fortat (memorie sau timp)'} (${c.steps[over].attempts} incercari)`);
    return [];
  }
  for (const name of stuck) c.steps[name] = { ...c.steps[name], status: 'waiting', lease: 0, scheduledAt: now };
  if (stuck.length) {
    await ctx.db.patch(c._id, { steps: c.steps, updatedAt: now });
    await schedule(ctx, c, stuck);
    await note(ctx, c.date, [`${stamp()} ${why}: reiau ${stuck.join(', ')}`], now + STEP_LEASE_MS);
  }
  return stuck;
}

// Porneste calculul zilei, sau il reia daca exista deja (aceeasi zi). Un singur calcul odata: altul in lucru
// pentru alta zi => { busy } (paznicul incearca din nou mai tarziu).
export const start = internalMutation({
  args: {
    date: v.string(), token: v.string(), gen: v.string(),
    countrySteps: v.array(v.string()), mergeSteps: v.array(v.string()), expect: v.number(),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    for (const c of await running(ctx)) {
      if (c.date === a.date) {
        await note(ctx, c.date, [], now + STEP_LEASE_MS);
        return { resumed: c.token, steps: await resume(ctx, c, now, 'calcul reluat') };
      }
      const busy = Object.values(c.steps).some((s) => s.status === 'running' && s.lease > now);
      if (busy || now - (c.updatedAt ?? c.startedAt) < STALE_MS) return { busy: c.date };
      await failCalc(ctx, c, `abandonat: nicio miscare din ${new Date(c.updatedAt ?? c.startedAt).toISOString()}`);
    }
    const steps = {};
    for (const name of a.countrySteps) steps[name] = { stage: 'country', status: 'waiting', attempts: 0, lease: 0, scheduledAt: now };
    for (const name of a.mergeSteps) steps[name] = { stage: 'merge', status: 'blocked', attempts: 0, lease: 0 };
    await ctx.db.insert('calcs', { date: a.date, token: a.token, gen: a.gen, status: 'running', startedAt: now, updatedAt: now, expect: a.expect, steps });
    await schedule(ctx, { token: a.token, steps }, a.countrySteps);
    await note(ctx, a.date, [`${stamp()} calcul pe pasi: ${a.countrySteps.length} tari in paralel, apoi ${a.mergeSteps.length} pasi comuni (generatia ${a.gen})`], now + STEP_LEASE_MS);
    return { started: a.token };
  },
});

// Un pas incepe: null daca nu mai e de facut (gata, alt exemplar lucreaza, calcul oprit).
export const claim = internalMutation({
  args: { token: v.string(), step: v.string() },
  handler: async (ctx, { token, step }) => {
    const c = await calcOf(ctx, token);
    const s = c?.steps[step];
    const now = Date.now();
    if (!c || c.status !== 'running' || !s || s.status === 'done' || s.status === 'blocked') return null;
    if (s.status === 'running' && s.lease > now) return null;
    if (s.attempts >= STEP_ATTEMPTS) {
      await failCalc(ctx, c, `${step}: ${s.error ?? 'oprit fortat (memorie sau timp)'} (${s.attempts} incercari)`);
      return null;
    }
    const attempt = s.attempts + 1;
    c.steps[step] = { ...s, status: 'running', attempts: attempt, lease: now + STEP_LEASE_MS, startedAt: now };
    await ctx.db.patch(c._id, { steps: c.steps, updatedAt: now });
    await ctx.scheduler.runAfter(STEP_LEASE_MS + 5_000, internal.calc.check, { token, step, attempt });
    await note(ctx, c.date, [], now + STEP_LEASE_MS);
    // Rezultatele pasilor tarilor (starea colectarii fiecarei tari), pentru pasul meta.
    const countries = {};
    for (const [name, x] of Object.entries(c.steps)) if (x.stage === 'country') countries[name.split('/')[1]] = x.info ?? null;
    return { date: c.date, gen: c.gen, attempt, countries };
  },
});

// Pasul a ramas "running" dupa ce i-a expirat rezervarea (actiunea a fost oprita fortat: memorie, timp), sau
// "waiting" la START_GRACE_MS dupa ora lui (actiunea n-a pornit deloc). `attempt`: incercarea verificata.
export const check = internalMutation({
  args: { token: v.string(), step: v.string(), attempt: v.number() },
  handler: async (ctx, { token, step, attempt }) => {
    const c = await calcOf(ctx, token);
    const s = c?.steps[step];
    const now = Date.now();
    if (!c || c.status !== 'running' || !s || s.attempts !== attempt) return;
    if (s.status === 'running' && s.lease <= now) {
      c.steps[step] = { ...s, error: s.error ?? 'oprit fortat (memorie sau timp)' };
      await resume(ctx, c, now, `${step} oprit fortat`);
    } else if (s.status === 'waiting' && (s.scheduledAt ?? 0) <= now - START_GRACE_MS) {
      c.steps[step] = { ...s, scheduledAt: now };
      await ctx.db.patch(c._id, { steps: c.steps, updatedAt: now });
      await startStep(ctx, c, step);
      await note(ctx, c.date, [`${stamp()} ${step}: actiunea n-a pornit, o programez din nou`]);
    }
  },
});

export const done = internalMutation({
  args: { token: v.string(), step: v.string(), attempt: v.optional(v.number()), info: v.optional(v.any()), log: v.array(v.string()) },
  handler: async (ctx, { token, step, info, log }) => {
    const c = await calcOf(ctx, token);
    const s = c?.steps[step];
    if (!c || c.status !== 'running' || !s || s.status === 'done') return;
    const now = Date.now();
    c.steps[step] = { ...s, status: 'done', lease: 0, ms: now - (s.startedAt ?? now), ...(info !== undefined ? { info } : {}) };
    const lines = [...log];
    const left = Object.values(c.steps).filter((x) => x.stage === s.stage && x.status !== 'done').length;
    let next = [];
    if (!left && s.stage === 'country') {
      next = Object.keys(c.steps).filter((n) => c.steps[n].stage === 'merge');
      for (const n of next) c.steps[n] = { ...c.steps[n], status: 'waiting', scheduledAt: now };
      lines.push(`${stamp()} tarile gata in ${secs(now - c.startedAt)}; urmeaza ${next.length} pasi comuni`);
    }
    await ctx.db.patch(c._id, { steps: c.steps, updatedAt: now });
    if (next.length) await schedule(ctx, c, next);
    if (!left && s.stage === 'merge') await ctx.scheduler.runAfter(0, internal.calc.publish, { token });
    await note(ctx, c.date, lines);
  },
});

export const failed = internalMutation({
  args: { token: v.string(), step: v.string(), attempt: v.number(), error: v.string(), log: v.array(v.string()) },
  handler: async (ctx, { token, step, attempt, error, log }) => {
    const c = await calcOf(ctx, token);
    const s = c?.steps[step];
    if (!c || c.status !== 'running' || !s) return;
    await note(ctx, c.date, log);
    // O incercare veche (intre timp pasul a fost reluat sau terminat) nu mai conteaza.
    if (s.status !== 'running' || s.attempts !== attempt) return;
    if (s.attempts >= STEP_ATTEMPTS) return failCalc(ctx, c, `${step}: ${error}`);
    const now = Date.now();
    const delay = RETRY_AFTER_MS * s.attempts;
    c.steps[step] = { ...s, status: 'waiting', lease: 0, error: error.slice(0, 300), scheduledAt: now + delay };
    await ctx.db.patch(c._id, { steps: c.steps, updatedAt: now });
    await schedule(ctx, c, [step], delay);
    await note(ctx, c.date, [`${stamp()} ${step}: reiau in ${secs(delay)} (incercarea ${s.attempts + 1} din ${STEP_ATTEMPTS})`]);
  },
});

// Toti pasii gata: site-ul trece pe generatia noua (doar daca are toate fisierele), ziua se inchide.
export const publish = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const c = await calcOf(ctx, token);
    if (!c || c.status !== 'running' || !allDone(c)) return;
    let n;
    try {
      n = await commitGen(ctx, c.gen, c.expect);
    } catch (err) {
      return failCalc(ctx, c, `publicare: ${err.message}`);
    }
    const now = Date.now();
    await ctx.db.patch(c._id, { status: 'done', finishedAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.calc.dropPieces, { token });
    // Vechea baza cu toate tarile (dinainte de calculul pe tari) nu mai e folosita.
    const legacy = await ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', 'db')).unique();
    if (legacy) {
      for (const id of legacy.storageIds ?? []) await ctx.storage.delete(id);
      await ctx.db.delete(legacy._id);
    }
    const longest = Object.entries(c.steps).sort((x, y) => (y[1].ms ?? 0) - (x[1].ms ?? 0)).slice(0, 3)
      .map(([name, s]) => `${name} ${secs(s.ms)}`).join(', ');
    await closeRun(ctx, c.date, { status: 'done', log: [`${stamp()} publicat: ${n} fisiere, generatia ${c.gen}; calculul a durat ${secs(now - c.startedAt)} (cei mai lungi pasi: ${longest})`] });
    return n;
  },
});

// Pentru paznic (collect.watchdog, la 10 minute): calculele in lucru cu pasi opriti sau pierduti.
export const watch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await running(ctx)) await resume(ctx, c, now, 'paznic');
  },
});

// ---- bucatile dintre pasi ----

export const addPieces = internalMutation({
  args: { token: v.string(), pieces: v.array(v.object({ key: v.string(), storageId: v.id('_storage') })) },
  handler: async (ctx, { token, pieces }) => {
    for (const p of pieces) {
      const old = await ctx.db.query('pieces').withIndex('by_token_key', (q) => q.eq('token', token).eq('key', p.key)).unique();
      if (old) {
        await ctx.storage.delete(old.storageId);
        await ctx.db.delete(old._id);
      }
      await ctx.db.insert('pieces', { token, ...p });
    }
  },
});

export const pieceIds = internalQuery({
  args: { token: v.string(), keys: v.array(v.string()) },
  handler: async (ctx, { token, keys }) => {
    const out = {};
    for (const key of keys) {
      const p = await ctx.db.query('pieces').withIndex('by_token_key', (q) => q.eq('token', token).eq('key', key)).unique();
      out[key] = p?.storageId ?? null;
    }
    return out;
  },
});

export const dropPieces = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const page = await ctx.db.query('pieces').withIndex('by_token_key', (q) => q.eq('token', token)).take(200);
    for (const p of page) {
      await ctx.storage.delete(p.storageId);
      await ctx.db.delete(p._id);
    }
    if (page.length === 200) await ctx.scheduler.runAfter(0, internal.calc.dropPieces, { token });
  },
});

// Pentru terminal: starea ultimului calcul (npx convex run --prod calc:last).
export const last = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await ctx.db.query('calcs').order('desc').first();
    if (!c) return null;
    const steps = Object.entries(c.steps).map(([name, s]) => `${name}: ${s.status}${s.attempts > 1 ? ` (x${s.attempts})` : ''}${s.ms ? ` ${secs(s.ms)}` : ''}${s.error ? ` ${s.error}` : ''}`);
    return { date: c.date, status: c.status, gen: c.gen, error: c.error ?? null, took: secs((c.finishedAt ?? Date.now()) - c.startedAt), steps };
  },
});
