// Calculul zilei pe acest calculator, cand Convex nu-l poate face (limita lui de memorie si disc). Face exact
// ce face process.run din Convex: baza de calcul din copia salvata, importul fisierelor zilnice noi din arhiva,
// curatenia, planul colectarii de maine, salvarea bazei inapoi in Convex, apoi exportul pentru site.
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
import { exportFiles } from './build.js';

const SITE = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET;
const PARALLEL = 8;
const DB_CHUNK = 64 * 1024 * 1024;
if (!SITE || !SECRET) {
  console.error('Lipsesc CONVEX_SITE_URL si/sau INGEST_SECRET.');
  process.exit(1);
}
const auth = { authorization: `Bearer ${SECRET}` };
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function call(route, opts = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${SITE}${route}`, { ...opts, headers: { ...auth, ...opts.headers } });
    if (res.ok) return res;
    if (i >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${route}: HTTP ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
}
const download = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());
const blob = async (buf, type = 'application/gzip') => (await (await call('/ingest/blob', { method: 'POST', headers: { 'content-type': type }, body: buf })).json()).storageId;
const setState = (name, body) => call('/ingest/state', json({ name, ...body }));

const started = Date.now();
const secs = () => `${Math.round((Date.now() - started) / 1000)} s`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-calc-'));
const file = path.join(dir, 'calc.db');
try {
  // 1. Baza de calcul, din copia salvata in Convex.
  const { at, urls } = await (await call('/ingest/db')).json();
  if (!urls.length) throw new Error('Convex nu are copia bazei');
  async function* chunks() { for (const u of urls) yield await download(u); }
  await pipeline(Readable.from(chunks()), createGunzip(), fs.createWriteStream(file));
  const db = openDb(file);
  console.log(`baza din ${at}: ${Math.round(fs.statSync(file).size / 1e6)} MB (${secs()})`);

  // 2. Fisierele zilnice din arhiva inca neimportate (in ordinea din importAll), apoi curatenia.
  const ci = (cc) => COUNTRIES.indexOf(cc);
  const raw = (await (await call('/ingest/raw-list')).json())
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.date.localeCompare(b.date) || ci(a.country) - ci(b.country));
  let imported = 0;
  for (const r of raw) {
    if (isImported(db, r)) continue;
    const q = new URLSearchParams({ kind: r.kind, date: r.date, country: r.country });
    const { url } = await (await call(`/ingest/raw-get?${q}`)).json();
    importFile(db, { ...r, value: JSON.parse(gunzipSync(await download(url)).toString('utf8')) });
    imported++;
  }
  prune(db);
  console.log(`importate: ${imported} fisiere (${secs()})`);

  // 3. Planul colectarii de maine.
  for (const cc of COUNTRIES) {
    const id = await blob(Buffer.from(JSON.stringify(collectPlan(db, cc))), 'application/json');
    await setState(`plan/${cc}`, { storageIds: [id] });
  }

  // 4. Baza inapoi in Convex (in bucati gzip); copia veche se sterge abia dupa ce cea noua e completa.
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
  await setState('db', { storageIds: ids, value: { bytes } });
  console.log(`baza salvata: ${Math.round(bytes / 1e6)} MB in ${ids.length} bucati (${secs()})`);

  // 5. Starea colectarii (pentru interfata): ultima zi din baza.
  const latest = db.prepare('SELECT MAX(date) d FROM days').get().d;
  const countries = Object.fromEntries(COUNTRIES.map((cc) => {
    const d = db.prepare('SELECT complete, requests, errors FROM days WHERE country=? AND date=?').get(cc, latest);
    return [cc, d ? { complete: !!d.complete, requests: d.requests, errors: d.errors } : { missing: true, error: 'missing' }];
  }));
  const cloud = { lastRun: latest, finishedAt: new Date().toISOString(), countries };
  await setState('cloud', { value: cloud });

  // 6. Exportul pentru site, intr-o generatie noua; site-ul trece pe ea doar daca e completa.
  const gen = new Date().toISOString().replace(/[:.]/g, '-');
  const pending = new Set();
  for (const [key, buf] of exportFiles(db, { cloud })) {
    const p = call(`/ingest/file?gen=${gen}&key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: buf })
      .finally(() => pending.delete(p));
    pending.add(p);
    if (pending.size >= PARALLEL) await Promise.race(pending);
  }
  await Promise.all(pending);
  db.close();
  const { files } = await (await call('/ingest/commit', json({ gen }))).json();
  console.log(`publicat: ${files} fisiere, ziua ${latest}, generatia ${gen} (${secs()})`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
