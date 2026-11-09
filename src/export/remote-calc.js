// Calculul zilei pe acest calculator, cand Convex nu-l poate face. Face ce fac pasii calculului din Convex
// (convex/process.js), pe tari: baza tarii din copia ei salvata in Convex (fara copie: una noua, din arhiva),
// fisierele zilnice din arhiva inca neimportate, curatenia, planul colectarii de maine si copia bazei inapoi in
// Convex; apoi starea colectarii si exportul pentru site (ca acolo: src/export/split.js), intr-o generatie noua,
// publicata doar daca are toate fisierele. Fisierele zilei colectate trebuie sa fie deja in arhiva (le salveaza
// pasul tarii din Convex, inainte de calcul).
//   CONVEX_SITE_URL=https://<deployment>.convex.site INGEST_SECRET=... node src/export/remote-calc.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { COUNTRIES } from '../apple/clients.js';
import { openDb, importFile, isImported, prune, KINDS } from '../local/db.js';
import { collectPlan } from '../compute/plan.js';
import { listVariants, TERM_SHARDS, APP_SHARDS } from './build.js';
import { splitExport } from './split.js';

const SITE = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET;
const PARALLEL = 8;
const PREFETCH = 8; // fisierele din arhiva se descarca cate 8 inainte, se importa pe rand (ordinea conteaza)
const DB_CHUNK = 64 * 1024 * 1024;
if (!SITE || !SECRET) {
  console.error('Lipsesc CONVEX_SITE_URL si/sau INGEST_SECRET.');
  process.exit(1);
}
const auth = { authorization: `Bearer ${SECRET}` };
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Reincearca si la erorile de retea (conexiune taiata), nu doar la raspunsurile 5xx/429.
async function retry(what, fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 5 || e.fatal) throw e;
      console.log(`  ${what}: ${e.cause?.code ?? e.message}, reincerc`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
}
const call = (route, opts = {}) => retry(route.split('?')[0], async () => {
  const res = await fetch(`${SITE}${route}`, { ...opts, headers: { ...auth, ...opts.headers } });
  if (res.ok) return res;
  const err = new Error(`${route}: HTTP ${res.status} ${await res.text()}`);
  err.status = res.status;
  err.fatal = res.status < 500 && res.status !== 429;
  throw err;
});
const download = (url) => retry('descarcare', async () => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarcare: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
});
const blob = async (buf, type = 'application/gzip') => (await (await call('/ingest/blob', { method: 'POST', headers: { 'content-type': type }, body: buf })).json()).storageId;
const setState = (name, body) => call('/ingest/state', json({ name, ...body }));

// Un fisier zilnic din arhiva: { value } sau { problem: 'missing' | 'corrupt' } (ca in process.js).
async function rawFile(r) {
  let res;
  try {
    res = await call(`/ingest/raw-get?${new URLSearchParams({ kind: r.kind, date: r.date, country: r.country })}`);
  } catch (err) {
    if (err.status === 404) return { problem: 'missing' };
    throw err;
  }
  const buf = await download((await res.json()).url);
  try {
    return { value: JSON.parse(gunzipSync(buf).toString('utf8')) };
  } catch {
    return { problem: 'corrupt' };
  }
}

// Copia bazei tarii din Convex; fara copie (sau cu una stricata), o baza noua, care se umple din arhiva.
async function openCountryDb(copy, file) {
  if (copy?.urls?.length) {
    try {
      async function* chunks() { for (const u of copy.urls) yield await download(u); }
      await pipeline(Readable.from(chunks()), createGunzip(), fs.createWriteStream(file));
      const db = openDb(file);
      try {
        db.prepare('SELECT COUNT(*) n FROM imported').get();
        return { db, restored: true };
      } catch (err) {
        db.close();
        throw err;
      }
    } catch (err) {
      console.log(`  copia bazei nu se poate folosi (${err.message}): o refac din arhiva`);
    }
  }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  return { db: openDb(file), restored: false };
}

// Fisierele tarii din arhiva inca neimportate (sau schimbate), pe tipuri (KINDS), apoi pe zile (ca importAll).
async function importNew(db, rows) {
  const todo = rows.filter((r) => !isImported(db, r))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.date.localeCompare(b.date));
  const loads = new Map();
  const load = (i) => {
    if (!loads.has(i)) {
      const p = rawFile(todo[i]);
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
    const got = await load(i);
    loads.delete(i);
    if (got.problem) {
      problem.run(`${r.kind}/${r.date}/${r.country}.json.gz`, got.problem);
      problems++;
      continue;
    }
    importFile(db, { ...r, value: got.value });
  }
  return { imported: todo.length - problems, problems };
}

// Baza inapoi in Convex (in bucati gzip); copia veche se sterge abia dupa ce cea noua e completa (setState).
async function saveDb(db, file, name) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const ids = [];
  let parts = [];
  let size = 0;
  const flush = async () => { if (size) { ids.push(await blob(Buffer.concat(parts, size))); parts = []; size = 0; } };
  await pipeline(fs.createReadStream(file), createGzip({ level: 4 }), new Writable({
    async write(chunk, _, done) { try { parts.push(chunk); size += chunk.length; if (size >= DB_CHUNK) await flush(); done(); } catch (e) { done(e); } },
    async final(done) { try { await flush(); done(); } catch (e) { done(e); } },
  }));
  const bytes = fs.statSync(file).size;
  await setState(name, { storageIds: ids, value: { bytes } });
  return bytes;
}

const started = Date.now();
const secs = () => `${Math.round((Date.now() - started) / 1000)} s`;
const mb = (n) => `${Math.round(n / 1e6)} MB`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-calc-'));
const dbs = new Map();
try {
  const { countries } = await (await call('/ingest/db')).json();
  const raw = await (await call('/ingest/raw-list')).json();

  // 1. Pe tari: baza, fisierele noi din arhiva, curatenia, planul de maine, copia bazei inapoi in Convex.
  const infos = {};
  for (const cc of COUNTRIES) {
    const file = path.join(dir, `${cc}.db`);
    const { db, restored } = await openCountryDb(countries?.[cc], file);
    dbs.set(cc, db);
    const { imported, problems } = await importNew(db, raw.filter((r) => r.country === cc));
    prune(db);
    const planId = await blob(Buffer.from(JSON.stringify(collectPlan(db, cc))), 'application/json');
    await setState(`plan/${cc}`, { storageIds: [planId] });
    const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=?').get(cc).d ?? null;
    const row = latest ? db.prepare('SELECT complete, requests, errors FROM days WHERE country=? AND date=?').get(cc, latest) : null;
    infos[cc] = { latest, status: row ? { complete: !!row.complete, requests: row.requests, errors: row.errors } : null };
    const bytes = await saveDb(db, file, `db/${cc}`);
    console.log(`${cc}: baza ${restored ? 'din copie' : 'noua, din arhiva'}, ${imported} fisiere importate`
      + `${problems ? `, ${problems} stricate` : ''}; ${mb(bytes)} salvata (${secs()})`);
  }

  // 2. Starea colectarii (pentru interfata): ultima zi din baze.
  const latest = COUNTRIES.map((cc) => infos[cc].latest).filter(Boolean).sort().at(-1) ?? null;
  const cloud = {
    lastRun: latest,
    finishedAt: new Date().toISOString(),
    countries: Object.fromEntries(COUNTRIES.map((cc) => [cc, infos[cc].latest === latest && infos[cc].status ? infos[cc].status : { missing: true, error: 'missing' }])),
  };
  await setState('cloud', { value: cloud });

  // 3. Exportul pentru site, intr-o generatie noua; site-ul trece pe ea doar daca are toate fisierele.
  const gen = new Date().toISOString().replace(/[:.]/g, '-');
  const expect = listVariants().length + 2 + TERM_SHARDS + APP_SHARDS;
  const pending = new Set();
  let n = 0;
  for (const [key, buf] of splitExport(dbs, { cloud, log: console.log })) {
    const p = call(`/ingest/file?gen=${gen}&key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: buf })
      .finally(() => pending.delete(p));
    pending.add(p);
    if (pending.size >= PARALLEL) await Promise.race(pending);
    if (++n % 100 === 0) console.log(`  ${n} fisiere`);
  }
  await Promise.all(pending);
  const { files } = await (await call('/ingest/commit', json({ gen, expect }))).json();
  console.log(`publicat: ${files} fisiere, ziua ${latest}, generatia ${gen} (${secs()})`);
} finally {
  for (const db of dbs.values()) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
