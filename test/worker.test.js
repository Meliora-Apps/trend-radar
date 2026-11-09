// Colectarea pe bucati (Convex) da exact aceleasi fisiere ca runCountry (linia de comanda), pe acelasi istoric.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCountry } from '../src/collect/run-country.js';
import { newJob, phaseItems, preparePhase, work, assembleDay, dayJob, LANES, SEARCH_BLOCKED_AFTER, SEARCH_BLOCKED_SHARED, SEARCH_GATE_STALE_MS, SEARCH_MIN_MS } from '../src/collect/worker.js';
import { HttpError, OutOfTime } from '../src/apple/net.js';
import { appFiles, grossingIds } from '../src/collect/steps.js';
import { collectPlan, appState } from '../src/compute/plan.js';
import { openDb, importAll } from '../src/local/db.js';
import { makeCounter } from '../src/apple/net.js';
import { readJsonGz, dayPath, classifyPath, appsPath, statsPath, changesPath } from '../src/data/files.js';
import { addDays } from '../src/util/dates.js';

// Un Apple de proba care se schimba de la o zi la alta (cuvinte noi, app-uri noi, versiuni noi, redenumiri).
function fakeApple(day, { failEvery = 0 } = {}) {
  const counter = makeCounter();
  let n = 0;
  const maybeFail = () => { if (failEvery && ++n % failEvery === 0) throw new Error('HTTP 500 (test)'); };
  const apps = (seed) => [0, 1, 2, 3, 4, 5].map((i) => ({ id: 100 + ((seed + i * 7) % 40), name: `App ${(seed + i * 7) % 40}`, genreId: 6000 + (i % 3), subgenreId: null, ratings: 50 * (i + 1) + day, stars: 4, releaseDate: '2026-09-01' }));
  return {
    counter,
    suggest: (p) => counter.track(async () => {
      maybeFail();
      const base = p.trim();
      const out = [`${base} app`, `${base} pro`];
      if (base.length <= 2 && (base.charCodeAt(0) + day) % 5 === 0) out.unshift(`${base} new${day}`);
      if (base.endsWith('new' + (day - 1))) out.push(`${base} tail`);
      return out;
    }),
    topApps: (t) => counter.track(async () => { maybeFail(); return apps(t.length + day); }),
    chart: (cc, type, genreId) => counter.track(async () => apps(genreId % 13 + day).map((a, i) => ({ rank: i + 1, id: a.id, name: a.name, genreId: a.genreId }))),
    newFeed: () => counter.track(async () => [{ rank: 1, id: 900 + day, name: `Fresh ${day}`, genreId: 6014 }]),
    upcoming: (term, cc, after) => counter.track(async () => {
      maybeFail();
      // O precomanda noua la cateva zile; cea veche se lanseaza in ziua 6 (o urmarim si dupa).
      return [{ id: 700 + (term.length % 3), position: 5 + day, name: `Soon ${term.length % 3}`, seller: 'Big', genreId: 6014,
        releaseDate: term.length % 3 === 0 ? '2026-03-07' : '2026-05-01', price: 0, pub: 50000 }]
        .filter((a) => a.releaseDate > after);
    }),
    appMeta: (ids) => counter.track(async () => {
      maybeFail();
      return ids.map((id) => ({ id, name: id % 9 === 0 && day % 2 ? `Renamed ${id}` : `App ${id}`, genreId: 6000, releaseDate: '2026-09-01', seller: 'S',
        ratings: id * 10 + day * 3, ratingsCur: id, stars: 4.5, version: `1.${Math.floor((day + id) / 4)}`, updated: '2026-10-10', price: id % 11 === 0 && day > 7 ? 1.99 : 0, notes: `Notes ${day}` }));
    }),
  };
}

async function collectInChunks({ date, plan, apple, msPerRequest = 1000, chunkMs = 37_000, lane = null, extra = {} }) {
  let now = 0;
  const clock = () => now;
  const origTrack = apple.counter.track;
  apple.counter.track = (fn) => { now += msPerRequest; return origTrack(fn); };
  let job = { ...newJob('US', date, lane), ...extra };
  const parts = {};
  let prep = null;
  let ticks = 0;
  while (job.phase !== 'done') {
    if (job.pos === 0 && ['expand', 'lookup', 'upcoming', 'classify'].includes(job.phase) && !job.prepared) {
      prep = preparePhase(job, { plan, parts });
      job = { ...job, prepared: true };
    }
    const phase = job.phase;
    const r = await work(job, { apple, items: phaseItems(job, prep), prep, deadline: now + chunkMs, clock, log: () => {} });
    (parts[phase] ??= []).push(...r.out);
    job = r.job.phase !== phase ? { ...r.job, prepared: false } : r.job;
    ticks++;
  }
  return { job, parts, ticks };
}

test('colectarea pe bucati = runCountry: aceleasi fisiere ale zilei', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trw-'));
  const start = '2026-03-01';
  // Istoric: 10 zile colectate cu runCountry.
  for (let d = 0; d < 10; d++) {
    await runCountry({ country: 'US', date: addDays(start, d), dataDir: dir, apple: fakeApple(d), log: () => {} });
  }
  const date = addDays(start, 10);
  const db = openDb();
  importAll(db, dir);
  const plan = collectPlan(db, 'US');
  const before = appState(db, 'US', date);

  // Azi: o data cu runCountry (referinta), o data pe bucati.
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), 'trw-ref-'));
  fs.cpSync(dir, ref, { recursive: true });
  await runCountry({ country: 'US', date, dataDir: ref, apple: fakeApple(10, { failEvery: 37 }), log: () => {} });

  const { job, parts, ticks } = await collectInChunks({ date, plan, apple: fakeApple(10, { failEvery: 37 }) });
  assert.ok(ticks > 20, `trebuia sa fie multe bucati (${ticks})`);
  const got = assembleDay(job, parts);
  const files = appFiles({ date, results: got.lookup, ...before, grossing: grossingIds(got.charts) });

  assert.deepEqual(got.day, readJsonGz(dayPath(ref, date, 'US')));
  assert.deepEqual(got.classify, readJsonGz(classifyPath(ref, date, 'US')));
  assert.deepEqual(files.meta, readJsonGz(appsPath(ref, date, 'US')));
  assert.deepEqual(files.stats, readJsonGz(statsPath(ref, date, 'US')));
  assert.deepEqual(files.changes, readJsonGz(changesPath(ref, date, 'US')));
  assert.ok(got.day.suggest.some((s) => s.kind === 'expand'), 'extinderea din plan');
  assert.ok(files.changes.some((c) => c.field === 'name') && files.changes.some((c) => c.field === 'version'));
  assert.ok(got.day.upcoming.length > 0, 'precomenzile zilei');
  assert.ok(plan.upcomingIds.includes(700), 'precomanda lansata ieri ramane urmarita');
  assert.ok(files.stats[700], 'si i se iau cifrele dupa lansare');
});

test('colectarea pe bucati: prea multe erori => oprire, zi incompleta', async () => {
  const apple = fakeApple(3, { failEvery: 2 });
  const { job, parts } = await collectInChunks({ date: '2026-03-04', plan: null, apple });
  assert.equal(job.aborted, true);
  assert.equal(job.keywordsOk, false);
  assert.equal(assembleDay(job, parts).day.complete, false);
  assert.ok((parts.base ?? []).length < 200);
});

// Istoricul de 10 zile (runCountry) si planul pentru ziua 11, comune testelor de mai jos.
async function history() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trw-'));
  const start = '2026-03-01';
  for (let d = 0; d < 10; d++) await runCountry({ country: 'US', date: addDays(start, d), dataDir: dir, apple: fakeApple(d), log: () => {} });
  const db = openDb();
  importAll(db, dir);
  return { dir, date: addDays(start, 10), plan: collectPlan(db, 'US'), before: appState(db, 'US', addDays(start, 10)) };
}

test('benzile (cuvinte + app-uri, in paralel in Convex) = runCountry: aceleasi fisiere ale zilei', async () => {
  const { dir, date, plan, before } = await history();
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), 'trw-ref-'));
  fs.cpSync(dir, ref, { recursive: true });
  await runCountry({ country: 'US', date, dataDir: ref, apple: fakeApple(10), log: () => {} });

  const lanes = await Promise.all(Object.keys(LANES).map((lane) => collectInChunks({ date, plan, apple: fakeApple(10), lane })));
  const parts = {};
  for (const l of lanes) for (const [phase, out] of Object.entries(l.parts)) (parts[phase] ??= []).push(...out);
  assert.deepEqual(lanes.map((l) => l.job.lane), ['words', 'apps']);
  const job = dayJob(lanes.map((l) => l.job));
  const got = assembleDay(job, parts);
  const files = appFiles({ date, results: got.lookup, ...before, grossing: grossingIds(got.charts) });
  assert.deepEqual(got.day, readJsonGz(dayPath(ref, date, 'US')));
  assert.deepEqual(got.classify, readJsonGz(classifyPath(ref, date, 'US')));
  assert.deepEqual(files.meta, readJsonGz(appsPath(ref, date, 'US')));
  assert.deepEqual(files.stats, readJsonGz(statsPath(ref, date, 'US')));
  assert.deepEqual(files.changes, readJsonGz(changesPath(ref, date, 'US')));
  assert.equal(got.day.complete, true);
});

test('cautarea blocata (403): clasificarea si precomenzile se opresc dupa cateva cereri, ziua ramane completa', async () => {
  const { date, plan } = await history();
  const blocked = () => {
    const a = fakeApple(10);
    a.topApps = () => a.counter.track(async () => { throw new HttpError(403, 'search'); });
    a.upcoming = () => a.counter.track(async () => { throw new HttpError(403, 'search'); });
    return a;
  };
  const words = await collectInChunks({ date, plan, apple: blocked(), lane: 'words', chunkMs: 3000 });
  const apps = await collectInChunks({ date, plan, apple: blocked(), lane: 'apps', chunkMs: 3000 });
  assert.deepEqual(words.job.blocked, ['classify']);
  assert.deepEqual(apps.job.blocked, ['upcoming']);
  assert.equal(words.job.keywordsOk, true);
  assert.equal(words.job.aborted, false);
  assert.deepEqual(words.parts.classify ?? [], []);
  const searches = (l) => l.job.requests - Object.entries(l.parts).filter(([ph]) => ph !== 'classify' && ph !== 'upcoming').reduce((n, [, o]) => n + o.length, 0);
  assert.equal(searches(words), SEARCH_BLOCKED_AFTER, 'doar cateva cereri de clasificare');
  assert.equal(searches(apps), SEARCH_BLOCKED_AFTER, 'doar cateva cereri de precomenzi');
});

test('Convex: pasii cu cautare se opresc la job.searchUntil (dar au cel putin SEARCH_MIN_MS), ziua ramane completa', async () => {
  const { date, plan } = await history();
  const msPerRequest = 10_000;
  const full = await collectInChunks({ date, plan, apple: fakeApple(10), lane: 'words', msPerRequest });
  const queue = full.parts.classify.length;
  // Fereastra cautarii trecuta deja (ex. sugestiile au durat mult): fiecare pas cu cautare primeste doar minimul.
  const words = await collectInChunks({ date, plan, apple: fakeApple(10), lane: 'words', msPerRequest, extra: { searchUntil: 0 } });
  const apps = await collectInChunks({ date, plan, apple: fakeApple(10), lane: 'apps', msPerRequest, extra: { searchUntil: 0 } });
  const most = SEARCH_MIN_MS / msPerRequest + 1;
  assert.ok(queue > most, `coada de test prea mica (${queue})`);
  assert.ok(words.parts.classify.length <= most && words.parts.classify.length >= most - 2, `clasificate: ${words.parts.classify.length}`);
  assert.ok(apps.parts.upcoming.length <= most && apps.parts.upcoming.length >= most - 2, `precomenzi: ${apps.parts.upcoming.length} (lista are ${plan.upcomingTerms?.length ?? 'UPCOMING_TERMS'})`);
  assert.equal(words.job.phase, 'done');
  assert.equal(apps.job.phase, 'done');
  assert.equal(words.job.keywordsOk, true);
  // Fara searchUntil (linia de comanda): clasificarea merge pana la capatul cozii, ca inainte.
  assert.equal(full.job.searchUntil, undefined);
});

test('Convex: o cerere care nu mai incape in bucata (OutOfTime) ramane pentru bucata urmatoare, fara eroare', async () => {
  const date = '2026-03-11';
  const apple = fakeApple(10);
  let left = 3;
  const topApps = apple.topApps;
  apple.topApps = (t, cc) => (left-- > 0 ? topApps(t, cc) : apple.counter.track(async () => { throw new OutOfTime(); }));
  const job = { ...newJob('US', date, 'words'), phase: 'classify' };
  const items = Array.from({ length: 10 }, (_, i) => `term ${i}`);
  const logs = [];
  const r = await work(job, { apple, items, prep: null, deadline: Infinity, log: (l) => logs.push(l) });
  assert.equal(r.job.phase, 'classify', 'pasul nu s-a terminat');
  assert.equal(r.job.pos, 3, 'a patra cerere ramane de facut');
  assert.equal(r.out.length, 3);
  assert.deepEqual({ requests: r.job.requests, failures: r.job.failures }, { requests: 3, failures: 0 });
  assert.deepEqual(logs, []);
});

test('Convex: 403 la rand la cautare in toate tarile (gate comun) opresc pasii cu cautare mai repede', async () => {
  const date = '2026-03-11';
  const items = Array.from({ length: 10 }, (_, i) => `term ${i}`);
  let now = 0;
  const clock = () => now;
  const searchApple = (status) => {
    const a = fakeApple(10);
    const topApps = a.topApps;
    a.topApps = (t, cc) => { now += 10; return status ? a.counter.track(async () => { throw new HttpError(status, 'search'); }) : topApps(t, cc); };
    return a;
  };
  const classify = (cc) => ({ job: { ...newJob(cc, date, 'words'), phase: 'classify' } });
  // O cerere pe banda pe rand, ca la pacerul comun: fiecare tara vede doar cateva 403 la rand, gate-ul le vede pe toate.
  const gate = { denied: 0 };
  const lanes = ['US', 'GB', 'DE', 'FR', 'IT', 'ES'].map((cc) => ({ ...classify(cc), apple: searchApple(403) }));
  for (let round = 0; round < SEARCH_BLOCKED_AFTER; round++) {
    for (const l of lanes) {
      if (l.job.phase !== 'classify') continue;
      const r = await work(l.job, { apple: l.apple, items, prep: null, deadline: now + 5, clock, log: () => {}, gate });
      l.job = r.job;
    }
  }
  assert.equal(lanes.reduce((n, l) => n + l.job.requests, 0), SEARCH_BLOCKED_SHARED, 'se opresc dupa SEARCH_BLOCKED_SHARED cereri respinse, nu dupa 5 la fiecare tara');
  for (const l of lanes) assert.deepEqual(l.job.blocked, ['classify'], l.job.country);

  assert.equal(gate.at, now, 'ora ultimului refuz (gate-ul trece la bucata urmatoare)');

  // Un raspuns bun la oricare tara pune gate-ul la zero.
  const g = { denied: SEARCH_BLOCKED_SHARED - 1, at: now };
  const l = classify('US');
  await work(l.job, { apple: searchApple(0), items, prep: null, deadline: now + 5, clock, log: () => {}, gate: g });
  assert.deepEqual(g, { denied: 0, at: undefined });

  // Un sir de refuzuri vechi nu mai opreste o banda care ajunge acum la cautare: incearca din nou.
  const late = classify('GB');
  const stale = { denied: SEARCH_BLOCKED_SHARED, at: now - SEARCH_GATE_STALE_MS - 1 };
  const r = await work(late.job, { apple: searchApple(403), items, prep: null, deadline: now + 5, clock, log: () => {}, gate: stale });
  assert.equal(r.job.blocked, undefined);
  assert.equal(r.job.requests, 1);
  assert.equal(stale.denied, 1);
});
