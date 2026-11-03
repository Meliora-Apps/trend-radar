// Colectarea pe bucati (Convex) da exact aceleasi fisiere ca runCountry (linia de comanda), pe acelasi istoric.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCountry } from '../src/collect/run-country.js';
import { newJob, phaseItems, preparePhase, work, assembleDay } from '../src/collect/worker.js';
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
    appMeta: (ids) => counter.track(async () => {
      maybeFail();
      return ids.map((id) => ({ id, name: id % 9 === 0 && day % 2 ? `Renamed ${id}` : `App ${id}`, genreId: 6000, releaseDate: '2026-09-01', seller: 'S',
        ratings: id * 10 + day * 3, ratingsCur: id, stars: 4.5, version: `1.${Math.floor((day + id) / 4)}`, updated: '2026-10-10', price: id % 11 === 0 && day > 7 ? 1.99 : 0, notes: `Notes ${day}` }));
    }),
  };
}

async function collectInChunks({ date, plan, apple, msPerRequest = 1000, chunkMs = 37_000 }) {
  let now = 0;
  const clock = () => now;
  const origTrack = apple.counter.track;
  apple.counter.track = (fn) => { now += msPerRequest; return origTrack(fn); };
  let job = newJob('US', date);
  const parts = {};
  let prep = null;
  let ticks = 0;
  while (job.phase !== 'done') {
    if (job.pos === 0 && ['expand', 'lookup', 'classify'].includes(job.phase) && !job.prepared) {
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
});

test('colectarea pe bucati: prea multe erori => oprire, zi incompleta', async () => {
  const apple = fakeApple(3, { failEvery: 2 });
  const { job, parts } = await collectInChunks({ date: '2026-03-04', plan: null, apple });
  assert.equal(job.aborted, true);
  assert.equal(job.keywordsOk, false);
  assert.equal(assembleDay(job, parts).day.complete, false);
  assert.ok((parts.base ?? []).length < 200);
});
