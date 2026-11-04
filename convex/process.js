'use node';
// Calculul zilei, dupa colectare (sau dupa o incarcare manuala de fisiere zilnice):
//  1. baza de calcul (SQLite, src/local/db.js) se reface din copia salvata (sau din arhiva, prima data);
//  2. bucatile culese azi -> fisierele zilei (arhiva `raw`), ca in data/ din depozit;
//  3. orice fisier din arhiva inca neimportat intra in baza; apoi curatenia (RETAIN) si planul de maine;
//  4. baza se salveaza (gzip, in bucati), apoi exportul pentru site (generatie noua) si stergerea celei vechi.
// O actiune are maxim 10 minute: daca timpul nu ajunge, exportul continua (pe parti) intr-o actiune noua,
// care reface baza din copia salvata la pasul 4.
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { gzipSync, gunzipSync, createGzip, createGunzip } from 'node:zlib';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { COUNTRIES } from '../src/apple/clients.js';
import { openDb, importFile, isImported, prune, KINDS } from '../src/local/db.js';
import { assembleDay } from '../src/collect/worker.js';
import { appFiles, grossingIds } from '../src/collect/steps.js';
import { collectPlan, appState } from '../src/compute/plan.js';
import { exportFiles, EXPORT_PARTS } from '../src/export/build.js';

const DB_CHUNK = 64 * 1024 * 1024;
const UPLOADS = 8;
const FILES_BATCH = 100;
const CONTINUE_AFTER_MS = 5 * 60_000; // o parte noua a exportului incepe doar daca actiunea e mai tanara de atat
const mb = () => `${Math.round(process.memoryUsage().rss / 1e6)} MB`;
// Node strange memoria nefolosita abia cand se apropie de limita lui (~3,6 GB aici), iar Convex opreste actiunea
// mai devreme. Exportul are nevoie de ~400 MB: curatam noi, des (fiecare curatare ~0,2 s).
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');
const GC_EVERY = 32;
const freeMb = (dir) => { const s = fs.statfsSync(dir); return Math.round((s.bavail * s.bsize) / 1e6); };

const blobOf = async (ctx, id) => {
  const b = await ctx.storage.get(id);
  if (!b) throw new Error(`fisier lipsa: ${id}`);
  return Buffer.from(await b.arrayBuffer());
};
const store = (ctx, buf, type = 'application/gzip') => ctx.storage.store(new Blob([buf], { type }));

async function restoreDb(ctx, file) {
  const s = await ctx.runQuery(internal.store.getState, { name: 'db' });
  if (!s?.storageIds.length) return false;
  async function* chunks() { for (const id of s.storageIds) yield await blobOf(ctx, id); }
  await pipeline(Readable.from(chunks()), createGunzip(), fs.createWriteStream(file));
  return true;
}

// Fara copie pe disc (discul temporar al actiunii e mic): jurnalul WAL se scrie in fisierul bazei,
// apoi fisierul se comprima direct, in bucati.
async function saveDb(ctx, db, file) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const ids = [];
  let parts = [];
  let size = 0;
  const flush = async () => {
    if (!size) return;
    ids.push(await store(ctx, Buffer.concat(parts, size)));
    parts = []; size = 0;
  };
  await pipeline(fs.createReadStream(file), createGzip({ level: 4 }), new Writable({
    async write(chunk, _, done) {
      try {
        parts.push(chunk); size += chunk.length;
        if (size >= DB_CHUNK) await flush();
        done();
      } catch (e) { done(e); }
    },
    async final(done) { try { await flush(); done(); } catch (e) { done(e); } },
  }));
  const bytes = fs.statSync(file).size;
  await ctx.runMutation(internal.store.setState, { name: 'db', storageIds: ids, value: { bytes } });
  return { chunks: ids.length, bytes };
}

async function allRaw(ctx) {
  const rows = [];
  let cursor = null;
  do {
    const page = await ctx.runQuery(internal.store.rawPage, { cursor });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  // Ordinea importului din importAll: pe tipuri, apoi pe zile, apoi pe tari.
  const ci = (cc) => COUNTRIES.indexOf(cc);
  return rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.date.localeCompare(b.date) || ci(a.country) - ci(b.country));
}

// Bucatile culese azi -> fisierele zilei, in arhiva. O tara deja salvata (ex. la o reluare) nu se reface.
async function saveCollected(ctx, db, date, log) {
  const jobs = await ctx.runQuery(internal.collect.dayJobs, { date });
  const status = {};
  for (const { country, job, parts } of jobs) {
    status[country] = { complete: !!job.keywordsOk, requests: job.requests, errors: job.failures };
    if (await ctx.runQuery(internal.store.rawOf, { kind: 'changes', date, country })) continue;
    const byPhase = {};
    for (const p of parts) (byPhase[p.phase] ??= []).push(...JSON.parse((await blobOf(ctx, p.storageId)).toString('utf8')));
    const got = assembleDay(job, byPhase);
    const files = appFiles({ date, results: got.lookup, ...appState(db, country, date), grossing: grossingIds(got.charts) });
    const out = { days: got.day, classify: got.classify, apps: files.meta, stats: files.stats, changes: files.changes };
    for (const kind of KINDS) {
      const buf = gzipSync(JSON.stringify(out[kind]));
      await ctx.runMutation(internal.store.saveRaw, { kind, date, country, storageId: await store(ctx, buf), size: buf.length });
    }
    log(`${country}: ${got.day.suggest.length} sugestii, ${Object.keys(got.classify).length} clasificate, ${Object.keys(files.stats).length} app-uri`);
  }
  return jobs.length ? status : null;
}

// Partile exportului, de la `part`, cat timp ajunge; intoarce urmatoarea parte (sau null daca s-a terminat).
async function exportParts(ctx, db, { gen, part, cloud, started, log }) {
  let i = part;
  for (; i < EXPORT_PARTS.length; i++) {
    if (i > part && Date.now() - started > CONTINUE_AFTER_MS) return i;
    const pending = new Set();
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const files = batch;
      batch = [];
      await ctx.runMutation(internal.data.addFiles, { gen, files });
    };
    let n = 0;
    gc();
    for (const [key, buf] of exportFiles(db, { cloud, log, parts: [EXPORT_PARTS[i]] })) {
      if (++n % GC_EVERY === 0) gc();
      const p = store(ctx, buf).then(async (storageId) => {
        batch.push({ key, storageId });
        if (batch.length >= FILES_BATCH) await flush();
      }).finally(() => pending.delete(p));
      pending.add(p);
      if (pending.size >= UPLOADS) await Promise.race(pending);
    }
    await Promise.all(pending);
    await flush();
    log(`${EXPORT_PARTS[i]} incarcate (${Math.round((Date.now() - started) / 1000)} s, ${mb()})`);
  }
  return null;
}

// Dupa export (sau o parte din el): ori trece site-ul pe generatia noua, ori programeaza continuarea.
async function afterExport(ctx, { date, token, gen, next, cloud, lines }) {
  if (next != null) {
    await ctx.runMutation(internal.store.note, { date, log: [...lines, `continui exportul de la ${EXPORT_PARTS[next]}`] });
    await ctx.scheduler.runAfter(0, internal.process.resume, { date, token, gen, part: next, cloud });
    return false;
  }
  const n = await ctx.runMutation(internal.data.commit, { gen });
  lines.push(`${new Date().toISOString().slice(11, 19)} publicat: ${n} fisiere, generatia ${gen}`);
  await ctx.runMutation(internal.collect.finish, { date, status: 'done', log: lines });
  return true;
}

async function failed(ctx, { date, err, lines, log }) {
  log(`EROARE: ${err.stack ?? err.message}`.slice(0, 1500));
  await ctx.runMutation(internal.collect.finish, { date, status: 'processing', error: String(err.message).slice(0, 500), log: lines });
}

export const run = internalAction({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const token = crypto.randomUUID();
    if (!(await ctx.runMutation(internal.store.claimProcess, { date, token }))) return 'alt calcul ruleaza';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    const started = Date.now();
    const lines = [];
    const log = (m) => { console.log(m); lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); };
    let keepLock = false;
    try {
      const file = path.join(dir, 'calc.db');
      const restored = await restoreDb(ctx, file);
      const db = openDb(file);
      log(`${restored ? `baza refacuta (${Math.round(fs.statSync(file).size / 1e6)} MB)` : 'baza noua (din arhiva)'}, disc liber ${freeMb(dir)} MB`);

      const collected = await saveCollected(ctx, db, date, log);
      let imported = 0;
      for (const r of await allRaw(ctx)) {
        if (isImported(db, r)) continue;
        importFile(db, { ...r, value: JSON.parse(gunzipSync(await blobOf(ctx, r.storageId)).toString('utf8')) });
        imported++;
      }
      prune(db);
      gc();
      log(`importate: ${imported} fisiere (${Math.round((Date.now() - started) / 1000)} s, ${mb()})`);

      for (const cc of COUNTRIES) {
        const id = await store(ctx, Buffer.from(JSON.stringify(collectPlan(db, cc))), 'application/json');
        await ctx.runMutation(internal.store.setState, { name: `plan/${cc}`, storageIds: [id] });
      }
      const saved = await saveDb(ctx, db, file);
      log(`baza salvata: ${Math.round(saved.bytes / 1e6)} MB in ${saved.chunks} bucati (${Math.round((Date.now() - started) / 1000)} s)`);

      // Starea colectarii, pentru interfata: tarile zilei colectate (sau, la o incarcare manuala, ultima zi din baza).
      const latest = db.prepare('SELECT MAX(date) d FROM days').get().d;
      const countries = collected ?? Object.fromEntries(COUNTRIES.map((cc) => {
        const d = db.prepare('SELECT complete, requests, errors FROM days WHERE country=? AND date=?').get(cc, latest);
        return [cc, d ? { complete: !!d.complete, requests: d.requests, errors: d.errors } : { missing: true, error: 'missing' }];
      }));
      const cloud = { lastRun: collected ? date : latest, finishedAt: new Date().toISOString(), countries };
      await ctx.runMutation(internal.store.setState, { name: 'cloud', value: cloud });

      const gen = new Date().toISOString().replace(/[:.]/g, '-');
      const next = await exportParts(ctx, db, { gen, part: 0, cloud, started, log });
      db.close();
      keepLock = !(await afterExport(ctx, { date, token, gen, next, cloud, lines }));
      return lines.join('\n');
    } catch (err) {
      await failed(ctx, { date, err, lines, log });
      throw err;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!keepLock) await ctx.runMutation(internal.store.releaseProcess, { token });
    }
  },
});

// Continuarea exportului: baza din copia salvata, apoi partile ramase.
export const resume = internalAction({
  args: { date: v.string(), token: v.string(), gen: v.string(), part: v.number(), cloud: v.any() },
  handler: async (ctx, { date, token, gen, part, cloud }) => {
    if (!(await ctx.runMutation(internal.store.claimProcess, { date, token }))) return 'alt calcul ruleaza';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    const started = Date.now();
    const lines = [];
    const log = (m) => { console.log(m); lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`); };
    let keepLock = false;
    try {
      const file = path.join(dir, 'calc.db');
      if (!(await restoreDb(ctx, file))) throw new Error('lipseste copia bazei');
      const db = openDb(file);
      log(`baza refacuta pentru export (${Math.round((Date.now() - started) / 1000)} s)`);
      const next = await exportParts(ctx, db, { gen, part, cloud, started, log });
      db.close();
      keepLock = !(await afterExport(ctx, { date, token, gen, next, cloud, lines }));
      return lines.join('\n');
    } catch (err) {
      await failed(ctx, { date, err, lines, log });
      throw err;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!keepLock) await ctx.runMutation(internal.store.releaseProcess, { token });
    }
  },
});
