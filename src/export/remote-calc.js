// Calculul exportului pe acest calculator, cand Convex nu-l poate face (limita lui de memorie si disc):
// descarca copia bazei de calcul din Convex, calculeaza toate fisierele si le incarca intr-o generatie noua.
//   CONVEX_SITE_URL=https://<deployment>.convex.site INGEST_SECRET=... node src/export/remote-calc.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { openDb } from '../local/db.js';
import { exportFiles } from './build.js';

const SITE = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET;
const PARALLEL = 8;
if (!SITE || !SECRET) {
  console.error('Lipsesc CONVEX_SITE_URL si/sau INGEST_SECRET.');
  process.exit(1);
}
const auth = { authorization: `Bearer ${SECRET}` };

async function call(route, opts = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${SITE}${route}`, { ...opts, headers: { ...auth, ...opts.headers } });
    if (res.ok) return res;
    if (i >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${route}: HTTP ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
}

const started = Date.now();
const { at, urls, cloud } = await (await call('/ingest/db')).json();
if (!urls.length) throw new Error('Convex nu are copia bazei');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-calc-'));
const file = path.join(dir, 'calc.db');
async function* chunks() { for (const u of urls) yield Buffer.from(await (await fetch(u)).arrayBuffer()); }
await pipeline(Readable.from(chunks()), createGunzip(), fs.createWriteStream(file));
console.log(`baza din ${at}: ${Math.round(fs.statSync(file).size / 1e6)} MB`);

const db = openDb(file);
const gen = new Date().toISOString().replace(/[:.]/g, '-');
const pending = new Set();
let n = 0;
for (const [key, buf] of exportFiles(db, { cloud })) {
  const p = call(`/ingest/file?gen=${gen}&key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: buf })
    .finally(() => pending.delete(p));
  pending.add(p);
  if (pending.size >= PARALLEL) await Promise.race(pending);
  if (++n % 100 === 0) console.log(`  ${n} fisiere`);
}
await Promise.all(pending);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
const { files } = await (await call('/ingest/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gen }) })).json();
console.log(`publicat: ${files} fisiere, generatia ${gen} (${Math.round((Date.now() - started) / 1000)} s)`);
