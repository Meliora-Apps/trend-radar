'use node';
// Calculul zilei, dupa colectare (sau dupa o incarcare manuala de fisiere zilnice), pe pasi mici (starea pasilor:
// convex/calc.js; exportul pe tari: src/export/split.js). Convex da unei actiuni Node 10 minute, 512 MB de memorie
// si ~512 MB de disc temporar; vechea baza cu toate tarile (~450 MB) nu mai incapea pe disc. Acum:
//  - pasul unei tari (6, in paralel), pe baza ei (SQLite, ~80 MB): baza din copia ei (state db/<CC>) sau, prima
//    data, din arhiva; bucatile culese azi -> fisierele zilei (arhiva `raw`); fisierele noi din arhiva intra in baza;
//    curatenia (RETAIN), planul de maine (plan/<CC>), copia bazei; apoi listele tarii (fisiere finale) si bucatile
//    ei pentru fisierele comune (tabela `pieces`);
//  - pasii comuni (22, in paralel, dupa toate tarile): meta + terms, listele ALL (5 grupe), term/* (8 grupe),
//    app/* (8 grupe), fiecare doar din bucatile de care are nevoie;
//  - publicarea (calc.publish): site-ul trece pe generatia noua doar daca are toate fisierele (EXPECTED_FILES).
// Masurat pe datele reale (Linux, Node 22): un pas de tara ~10 s de calcul si max ~210 MB, un pas comun cateva
// secunde si max ~215 MB. Calculul greu ruleaza intr-un worker cu memoria limitata (WORKER_HEAP_MB).
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { gzipSync, gunzipSync, createGzip, createGunzip } from 'node:zlib';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { COUNTRIES, makeAppleClient } from '../src/apple/clients.js';
import { makeRetry } from '../src/apple/net.js';
import { openDb, importFile, isImported, prune, KINDS } from '../src/local/db.js';
import { assembleDay, dayJob } from '../src/collect/worker.js';
import { appFiles, grossingIds, upcomingTermsFrom } from '../src/collect/steps.js';
import { collectPlan, appState } from '../src/compute/plan.js';
import { listVariants, TERM_SHARDS, APP_SHARDS } from '../src/export/build.js';
import {
  countryParts, mergeMeta, mergeLists, mergeTermGroup, mergeAppGroup, unpack, fromGz,
  LIST_GROUPS, TERM_GROUPS, APP_GROUPS,
} from '../src/export/split.js';

const COUNTRY_STEPS = COUNTRIES.map((cc) => `country/${cc}`);
const MERGE_STEPS = [
  'meta',
  ...LIST_GROUPS.map((_, i) => `lists/${i}`),
  ...Array.from({ length: TERM_GROUPS }, (_, g) => `terms/${g}`),
  ...Array.from({ length: APP_GROUPS }, (_, g) => `apps/${g}`),
];
// Toate listele + meta + terms + paginile cuvintelor si ale app-urilor.
const EXPECTED_FILES = listVariants().length + 2 + TERM_SHARDS + APP_SHARDS;
const DB_CHUNK = 64 * 1024 * 1024;
const BATCH = 16; // fisiere/bucati inregistrate odata (o actiune oprita fortat lasa putine neinregistrate)
const PREFETCH = 8; // fisierele din arhiva se descarca cate 8 inainte, se importa pe rand (ordinea conteaza)
const WORKER_HEAP_MB = 320;
const WORKER_CREDIT = 16; // cate fisiere poate trimite worker-ul inainte sa astepte incarcarea lor
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

const secs = (ms) => `${Math.round(ms / 100) / 10} s`;
const mbOf = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const blobOf = async (ctx, id) => {
  const b = await ctx.storage.get(id);
  if (!b) throw new Error(`fisier lipsa: ${id}`);
  return Buffer.from(await b.arrayBuffer());
};
const store = (ctx, buf, type = 'application/gzip') => ctx.storage.store(new Blob([buf], { type }));

// ---- worker-ul (acelasi fisier, pornit de runJob): calculeaza fisierele unui pas si le trimite pe rand ----

function* jobParts(job, log) {
  const buf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const json = (list) => list.map((u8) => fromGz(buf(u8)));
  const bundles = (list) => list.map((u8) => unpack(buf(u8)));
  let files;
  switch (job.type) {
    case 'country': {
      const db = openDb(job.file);
      try {
        yield* countryParts(db, job.cc, { log });
      } finally {
        db.close();
      }
      return;
    }
    case 'meta': files = mergeMeta(json(job.infos), json(job.seen), { cloud: job.cloud }); break;
    case 'lists': files = mergeLists(bundles(job.memo), { group: LIST_GROUPS[job.group] }); break;
    case 'terms': files = mergeTermGroup(job.g, bundles(job.terms), json(job.infos)); break;
    case 'apps': files = mergeAppGroup(job.g, bundles(job.apps)); break;
    default: throw new Error(`pas necunoscut: ${job.type}`);
  }
  for (const [key, b] of files) yield ['file', key, b];
}

if (!isMainThread && workerData?.trJob) {
  let credit = WORKER_CREDIT;
  let wake = null;
  parentPort.on('message', () => { credit++; wake?.(); wake = null; });
  parentPort.postMessage({ ready: true });
  (async () => {
    for (const [kind, key, b] of jobParts(workerData.trJob, (m) => parentPort.postMessage({ log: m }))) {
      while (credit <= 0) await new Promise((r) => { wake = r; });
      credit--;
      // Copie: bufferele mici ale Node impart acelasi ArrayBuffer, care nu poate fi mutat in alt fir.
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
      parentPort.postMessage({ kind, key, ab }, [ab]);
    }
    parentPort.postMessage({ done: true });
    parentPort.close();
  })().catch((err) => { throw err; });
}

// ---- firul principal ----

// Incarcarea fisierelor si a bucatilor unui pas, pe masura ce sunt gata; inregistrarea lor, in loturi.
function uploader(ctx, { gen, token }) {
  const counts = { files: 0, pieces: 0, bytes: 0 };
  const pending = new Set();
  let failure = null;
  let files = [];
  let pieces = [];
  const flush = async (all) => {
    const tasks = [];
    if (files.length >= BATCH || (all && files.length)) {
      const batch = files;
      files = [];
      tasks.push(ctx.runMutation(internal.data.addFiles, { gen, files: batch }));
    }
    if (pieces.length >= BATCH || (all && pieces.length)) {
      const batch = pieces;
      pieces = [];
      tasks.push(ctx.runMutation(internal.calc.addPieces, { token, pieces: batch }));
    }
    await Promise.all(tasks);
  };
  return {
    counts,
    add(kind, key, b) {
      const p = store(ctx, b).then(async (storageId) => {
        (kind === 'file' ? files : pieces).push({ key, storageId });
        counts[kind === 'file' ? 'files' : 'pieces']++;
        counts.bytes += b.length;
        await flush(false);
      });
      pending.add(p);
      p.catch((err) => { failure ??= err; }).finally(() => pending.delete(p));
      return p;
    },
    async finish() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (failure) throw failure;
      await flush(true);
      return counts;
    },
  };
}

// Un pas greu, intr-un worker cu memoria limitata (la final se inchide si elibereaza tot). `build` pregateste
// datele pasului (le muta in worker). Daca worker-ul nici nu porneste, pasul se calculeaza aici.
async function runJob(ctx, build, { gen, token, log }) {
  const up = uploader(ctx, { gen, token });
  const { job, transfer } = await build();
  const outcome = await new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { trJob: job }, transferList: transfer, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    let ready = false;
    let done = false;
    let failure = null;
    w.on('message', (m) => {
      if (m.ready) { ready = true; return; }
      if (m.log) { log(m.log); return; }
      if (m.done) { done = true; return; }
      up.add(m.kind, m.key, Buffer.from(m.ab)).then(() => w.postMessage('ack'), (err) => { failure ??= err; w.terminate(); });
    });
    w.on('error', (err) => { failure ??= err; });
    w.on('exit', (code) => resolve({ ready, done, failure, code }));
  });
  if (!outcome.ready) {
    log(`worker-ul nu porneste (${outcome.failure?.message ?? `cod ${outcome.code}`}): calculez in actiune`);
    const again = await build();
    for (const [kind, key, b] of jobParts(again.job, log)) await up.add(kind, key, b);
    return up.finish();
  }
  const counts = await up.finish();
  if (outcome.failure) throw outcome.failure;
  if (!outcome.done) throw new Error(`calculul s-a oprit (cod ${outcome.code})`);
  return counts;
}

// Un calcul oprit fortat (memorie, timp) nu-si sterge folderul temporar, iar discul (mic) e refolosit de la o
// actiune la alta: la pornire stergem ce a ramas de la actiunile moarte (si de la vechiul calcul, tot tr-*),
// la fel fisierele temporare ale SQLite ramase de la ele (etilqs_*). O actiune traieste cel mult 10 minute: ce e
// mai vechi de STALE_TMP_MS nu mai e al nimanui; folderele pasilor in lucru in acelasi proces nu se ating oricum.
const STALE_TMP_MS = 11 * 60_000;
const live = (globalThis.__trendRadarTmp ??= new Set());
function tmpDir() {
  const tmp = os.tmpdir();
  let gone = 0;
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith('tr-') && !name.startsWith('etilqs_')) continue;
    const full = path.join(tmp, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (live.has(full) || Date.now() - st.mtimeMs < STALE_TMP_MS) continue;
    fs.rmSync(full, { recursive: true, force: true });
    gone++;
  }
  const dir = fs.mkdtempSync(path.join(tmp, 'tr-'));
  live.add(dir);
  const s = fs.statfsSync(tmp);
  return { dir, gone, free: s.bavail * s.bsize };
}

// Cea mai mare memorie a actiunii (RSS) cat timp lucreaza un pas, pentru jurnal.
function memWatch() {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 200);
  return { peak: () => Math.max(peak, process.memoryUsage.rss()), stop: () => clearInterval(timer) };
}

// Un pas: rezervarea (calc.claim), lucrul, apoi calc.done (sau calc.failed, care il reia).
// Starea pasilor (calc.claim / done / failed) sta intr-un singur document: cand multi pasi raporteaza odata, o
// mutatie se poate ciocni (OCC) de mai multe ori decat o reincearca Convex. Toate trei se pot repeta fara grija:
// claim intoarce null daca pasul e deja rezervat, done ignora un pas gata, failed o incercare deja raportata.
async function stepMutation(ctx, fn, args, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await ctx.runMutation(fn, args);
    } catch (err) {
      if (i >= tries) throw err;
      console.log(`[${args.step}] reincerc starea pasului (${i}) dupa: ${String(err.message).slice(0, 150)}`);
      await new Promise((r) => setTimeout(r, i * (250 + Math.random() * 750)));
    }
  }
}

async function runStep(ctx, { token, step }, work) {
  const claim = await stepMutation(ctx, internal.calc.claim, { token, step });
  if (!claim) return 'nimic de facut';
  const started = Date.now();
  const lines = [];
  const log = (m) => { console.log(`[${step}] ${m}`); lines.push(`${new Date().toISOString().slice(11, 19)} ${step}: ${m}`); };
  let mem = null;
  let tmp = null;
  try {
    mem = memWatch();
    tmp = tmpDir();
    if (claim.attempt > 1 || tmp.gone) log(`incercarea ${claim.attempt}; disc liber ${mbOf(tmp.free)}${tmp.gone ? ` (sters ${tmp.gone} ramase)` : ''}`);
    const info = await work({ ...claim, token, step, dir: tmp.dir, log });
    log(`gata in ${secs(Date.now() - started)}, memorie max ${mbOf(mem.peak())}`);
    await stepMutation(ctx, internal.calc.done, { token, step, attempt: claim.attempt, info, log: lines });
    return lines.join('\n');
  } catch (err) {
    console.log(`[${step}] EROARE: ${err.stack ?? err.message}`);
    log(`EROARE dupa ${secs(Date.now() - started)}${mem ? ` (memorie max ${mbOf(mem.peak())})` : ''}: ${String(err.message).slice(0, 300)}`);
    await stepMutation(ctx, internal.calc.failed, { token, step, attempt: claim.attempt, error: String(err.message).slice(0, 500), log: lines });
    throw err;
  } finally {
    mem?.stop();
    if (tmp) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
      live.delete(tmp.dir);
    }
  }
}

// ---- pasul unei tari ----

async function restoreDb(ctx, name, file) {
  const s = await ctx.runQuery(internal.store.getState, { name });
  if (!s?.storageIds.length) return false;
  async function* chunks() { for (const id of s.storageIds) yield await blobOf(ctx, id); }
  await pipeline(Readable.from(chunks()), createGunzip(), fs.createWriteStream(file));
  return true;
}

// Baza tarii din copia ei; fara copie (sau cu o copie stricata), una noua, care se umple din arhiva.
async function openCountryDb(ctx, cc, file, log) {
  try {
    if (await restoreDb(ctx, `db/${cc}`, file)) {
      const db = openDb(file);
      try {
        db.prepare('SELECT COUNT(*) n FROM imported').get();
        return { db, restored: true };
      } catch (err) {
        db.close();
        throw err;
      }
    }
  } catch (err) {
    log(`copia bazei nu se poate folosi (${err.message}): o refac din arhiva`);
  }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  return { db: openDb(file), restored: false };
}

// Fara copie pe disc (discul temporar e mic): jurnalul WAL se scrie in fisierul bazei, apoi fisierul se comprima
// direct, in bucati.
async function saveDb(ctx, db, file, name) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const ids = [];
  let parts = [];
  let size = 0;
  let packed = 0;
  const flush = async () => {
    if (!size) return;
    ids.push(await store(ctx, Buffer.concat(parts, size)));
    packed += size;
    parts = [];
    size = 0;
  };
  await pipeline(fs.createReadStream(file), createGzip({ level: 4 }), new Writable({
    async write(chunk, _, done) {
      try {
        parts.push(chunk);
        size += chunk.length;
        if (size >= DB_CHUNK) await flush();
        done();
      } catch (e) { done(e); }
    },
    async final(done) { try { await flush(); done(); } catch (e) { done(e); } },
  }));
  const bytes = fs.statSync(file).size;
  await ctx.runMutation(internal.store.setState, { name, storageIds: ids, value: { bytes } });
  return { bytes, packed };
}

// Bucatile culese azi (ambele benzi ale tarii) -> fisierele zilei, in arhiva. Intoarce starea colectarii tarii
// (null = azi nu s-a colectat). O zi deja salvata (ex. la o reluare) nu se reface.
async function saveCollected(ctx, db, date, cc, log) {
  const rows = await ctx.runQuery(internal.collect.dayJobs, { date, country: cc });
  if (!rows.length || rows.some((r) => r.job.smoke)) return null;
  const job = dayJob(rows.map((r) => r.job));
  const status = { complete: !!job.keywordsOk, requests: job.requests, errors: job.failures };
  if (await ctx.runQuery(internal.store.rawOf, { kind: 'changes', date, country: cc })) return status;
  if (!rows.some((r) => r.parts.length)) {
    log('colectarea nu mai are bucatile culese: ziua nu se poate salva');
    return status;
  }
  const byPhase = {};
  for (const r of rows) {
    for (const p of r.parts) (byPhase[p.phase] ??= []).push(...JSON.parse((await blobOf(ctx, p.storageId)).toString('utf8')));
  }
  const got = assembleDay(job, byPhase);
  const files = appFiles({ date, results: got.lookup, ...appState(db, cc, date), grossing: grossingIds(got.charts) });
  const out = { days: got.day, classify: got.classify, apps: files.meta, stats: files.stats, changes: files.changes };
  for (const kind of KINDS) {
    const buf = gzipSync(JSON.stringify(out[kind]));
    await ctx.runMutation(internal.store.saveRaw, { kind, date, country: cc, storageId: await store(ctx, buf), size: buf.length });
  }
  log(`ziua salvata: ${got.day.suggest.length} sugestii, ${Object.keys(got.classify).length} clasificate, ${Object.keys(files.stats).length} app-uri`);
  return status;
}

// Fisierele tarii din arhiva, ca importAll(..., { countries: [cc] }): pe tipuri (KINDS), apoi pe zile.
async function rawOfCountry(ctx, cc) {
  const rows = [];
  let cursor = null;
  do {
    const page = await ctx.runQuery(internal.store.rawCountryPage, { country: cc, cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.date.localeCompare(b.date));
}

// Fisierele din arhiva inca neimportate (sau schimbate) intra in baza (cu `before`: doar zilele dinaintea ei).
// Unul stricat ajunge in `problems`.
async function importNew(ctx, db, cc, { before = null } = {}) {
  const todo = (await rawOfCountry(ctx, cc)).filter((r) => (before == null || r.date < before) && !isImported(db, r));
  const loads = new Map();
  const load = (i) => {
    if (!loads.has(i)) {
      const p = blobOf(ctx, todo[i].storageId);
      p.catch(() => {}); // o eroare se vede cand ii vine randul
      loads.set(i, p);
    }
    return loads.get(i);
  };
  const problem = db.prepare('INSERT OR REPLACE INTO problems VALUES (?,?)');
  let problems = 0;
  for (let i = 0; i < todo.length; i++) {
    for (let k = i; k < Math.min(todo.length, i + PREFETCH); k++) load(k);
    const r = todo[i];
    let value;
    try {
      value = JSON.parse(gunzipSync(await load(i)).toString('utf8'));
    } catch (err) {
      problem.run(`${r.kind}/${r.date}/${r.country}.json.gz`, err.message.startsWith('fisier lipsa') ? 'missing' : 'corrupt');
      problems++;
      continue;
    } finally {
      loads.delete(i);
    }
    importFile(db, { ...r, value });
  }
  return { imported: todo.length - problems, problems };
}

async function countryWork(ctx, { date, gen, token, step, dir, log }) {
  const cc = step.split('/')[1];
  const file = path.join(dir, `${cc}.db`);
  let t = Date.now();
  const lap = () => { const s = secs(Date.now() - t); t = Date.now(); return s; };
  const { db, restored } = await openCountryDb(ctx, cc, file, log);
  let info;
  try {
    // Intai istoricul care lipseste bazei (fara copie: toata arhiva tarii), ca fisierele zilei (app-urile noi,
    // redenumirile, versiunile noi: appState) sa se faca fata de tot ce stim; apoi fisierele zilei.
    const early = await importNew(ctx, db, cc, { before: date });
    const collected = await saveCollected(ctx, db, date, cc, log);
    const late = await importNew(ctx, db, cc);
    const imported = early.imported + late.imported;
    const problems = early.problems + late.problems;
    prune(db);
    const planId = await store(ctx, Buffer.from(JSON.stringify(collectPlan(db, cc))), 'application/json');
    await ctx.runMutation(internal.store.setState, { name: `plan/${cc}`, storageIds: [planId] });
    // Starea colectarii, pentru interfata (vezi pasul meta): cea de azi sau, la o incarcare manuala, ultima zi din baza.
    const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=?').get(cc).d ?? null;
    const row = latest ? db.prepare('SELECT complete, requests, errors FROM days WHERE country=? AND date=?').get(cc, latest) : null;
    info = {
      collected: !!collected,
      latest,
      status: collected ?? (row ? { complete: !!row.complete, requests: row.requests, errors: row.errors } : { missing: true, error: 'missing' }),
    };
    const saved = await saveDb(ctx, db, file, `db/${cc}`);
    log(`baza ${restored ? 'din copie' : 'noua, din arhiva'}: ${imported} fisiere importate${problems ? `, ${problems} stricate` : ''}; `
      + `${mbOf(saved.bytes)}, copia ${mbOf(saved.packed)} (${lap()})`);
  } finally {
    db.close();
  }
  gc();
  const sent = await runJob(ctx, async () => ({ job: { type: 'country', file, cc }, transfer: [] }), { gen, token, log });
  log(`export: ${sent.files} fisiere, ${sent.pieces} bucati, ${mbOf(sent.bytes)} (${lap()})`);
  return info;
}

// ---- pasii comuni ----

// Starea colectarii pentru interfata (fisierul meta + state 'cloud'), din rezultatele pasilor tarilor.
function cloudOf(date, infos) {
  const of = (cc) => infos[cc] ?? null;
  const collected = COUNTRIES.some((cc) => of(cc)?.collected);
  const latest = COUNTRIES.map((cc) => of(cc)?.latest).filter(Boolean).sort().at(-1) ?? null;
  const countries = collected
    ? Object.fromEntries(COUNTRIES.filter((cc) => of(cc)?.collected).map((cc) => [cc, of(cc).status]))
    : Object.fromEntries(COUNTRIES.map((cc) => [cc, of(cc)?.latest === latest && of(cc)?.status ? of(cc).status : { missing: true, error: 'missing' }]));
  return { lastRun: collected ? date : latest, finishedAt: new Date().toISOString(), countries };
}

// De ce bucati are nevoie fiecare pas comun (in ordinea COUNTRIES).
function piecesFor(kind, g) {
  const each = (prefix, suffix = '') => COUNTRIES.map((cc) => `${prefix}/${cc}${suffix}`);
  switch (kind) {
    case 'meta': return { infos: each('info'), seen: each('seen') };
    case 'lists': return { memo: each('memo') };
    case 'terms': return { terms: each('terms', `/${g}`), infos: each('info') };
    case 'apps': return { apps: each('apps', `/${g}`) };
    default: throw new Error(`pas necunoscut: ${kind}`);
  }
}

async function mergeWork(ctx, { date, gen, token, step, countries, log }) {
  const [kind, n] = step.split('/');
  const g = Number(n);
  const need = piecesFor(kind, g);
  const keys = [...new Set(Object.values(need).flat())];
  const ids = await ctx.runQuery(internal.calc.pieceIds, { token, keys });
  const missing = keys.filter((k) => !ids[k]);
  if (missing.length) throw new Error(`lipsesc bucatile ${missing.join(', ')}`);
  let cloud = null;
  if (kind === 'meta') {
    cloud = cloudOf(date, countries);
    await ctx.runMutation(internal.store.setState, { name: 'cloud', value: cloud });
  }
  let downloaded = 0;
  const build = async () => {
    const got = new Map(await Promise.all(keys.map(async (k) => [k, await blobOf(ctx, ids[k])])));
    downloaded = [...got.values()].reduce((s, b) => s + b.length, 0);
    const job = { type: kind, g, group: g, cloud };
    for (const [field, list] of Object.entries(need)) job[field] = list.map((k) => got.get(k));
    // Bufferele descarcate au fiecare ArrayBuffer-ul lor: se muta in worker, fara copie.
    const transfer = [...new Set([...got.values()].filter((b) => b.byteOffset === 0 && b.byteLength === b.buffer.byteLength).map((b) => b.buffer))];
    return { job, transfer };
  };
  const sent = await runJob(ctx, build, { gen, token, log });
  log(`${sent.files} fisiere, ${mbOf(sent.bytes)} (din ${keys.length} bucati, ${mbOf(downloaded)})`);
}

// ---- actiunile ----

// Porneste calculul zilei (sau il reia, daca exista deja unul pentru aceeasi zi).
export const run = internalAction({
  args: { date: v.string() },
  handler: (ctx, { date }) => ctx.runMutation(internal.calc.start, {
    date, token: crypto.randomUUID(), gen: new Date().toISOString().replace(/[:.]/g, '-'),
    countrySteps: COUNTRY_STEPS, mergeSteps: MERGE_STEPS, expect: EXPECTED_FILES,
  }),
});

export const country = internalAction({
  args: { token: v.string(), step: v.string() },
  handler: (ctx, a) => runStep(ctx, a, (s) => countryWork(ctx, s)),
});

export const merge = internalAction({
  args: { token: v.string(), step: v.string() },
  handler: (ctx, a) => runStep(ctx, a, (s) => mergeWork(ctx, s)),
});

// Unealta manuala: cauta precomenzile pentru o zi deja colectata (o tara) si le adauga in fisierul zilei din arhiva.
// Dupa toate tarile: process:run pentru aceeasi zi. npx convex run --prod process:addUpcoming '{"date":"...","country":"US"}'
export const addUpcoming = internalAction({
  args: { date: v.string(), country: v.string() },
  handler: async (ctx, { date, country }) => {
    const raw = await ctx.runQuery(internal.store.rawOf, { kind: 'days', date, country });
    if (!raw) throw new Error(`lipseste ziua ${date}/${country}`);
    const day = JSON.parse(gunzipSync(await blobOf(ctx, raw.storageId)).toString('utf8'));
    const apple = makeAppleClient({ retry: makeRetry({ retries: 2, baseDelayMs: 15_000, log: console.log }) });
    const deadline = Date.now() + 8 * 60_000;
    const upcoming = [];
    for (const term of upcomingTermsFrom(day.charts)) {
      if (Date.now() > deadline) break;
      try {
        upcoming.push({ term, apps: await apple.upcoming(term, country, date) });
      } catch (err) {
        console.log(`${country} "${term}": ${err.message}`);
      }
    }
    const buf = gzipSync(JSON.stringify({ ...day, upcoming }));
    await ctx.runMutation(internal.store.saveRaw, { kind: 'days', date, country, storageId: await store(ctx, buf), size: buf.length });
    const ids = new Set(upcoming.flatMap((u) => u.apps.map((a) => a.id)));
    return `${country}: ${upcoming.length} cautari, ${ids.size} precomenzi`;
  },
});
