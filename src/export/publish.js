// Publicarea zilnica pentru varianta online: data/ -> local.db -> export -> Convex.
//   CONVEX_SITE_URL=https://<deployment>.convex.site INGEST_SECRET=... node src/export/publish.js
// (in GitHub Actions, dupa colectare; DB_FILE poate fi un local.db pastrat in cache intre rulari)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, importAll } from '../local/db.js';
import { buildExport } from './build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET;
const PARALLEL = 8;
const RETRIES = 4;

if (!SITE || !SECRET) {
  console.error('Lipsesc CONVEX_SITE_URL si/sau INGEST_SECRET.');
  process.exit(1);
}

const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = openDb(process.env.DB_FILE ?? path.join(ROOT, 'local.db'));
console.log(`Import: ${JSON.stringify(importAll(db, DATA))}`);
let cloud = null;
try { cloud = JSON.parse(fs.readFileSync(path.join(DATA, 'status.json'), 'utf8')); } catch { /* inca nicio colectare */ }

const files = [];
const sizes = buildExport(db, (key, buf) => files.push([key, buf]), { cloud });
console.log(`Export: ${files.length} fisiere, ${(files.reduce((n, [, b]) => n + b.length, 0) / 1e6).toFixed(1)} MB ${JSON.stringify(sizes)}`);

const gen = new Date().toISOString().replace(/[:.]/g, '-');
const post = async (route, body, type) => {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${SITE}${route}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': type }, body });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`${route}: HTTP ${res.status} ${await res.text()}`), { fatal: true });
      throw new Error(`${route}: HTTP ${res.status}`);
    } catch (err) {
      if (err.fatal || i >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
};

let next = 0;
let done = 0;
const t = Date.now();
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < files.length) {
    const [key, buf] = files[next++];
    await post(`/ingest/file?gen=${encodeURIComponent(gen)}&key=${encodeURIComponent(key)}`, buf, 'application/gzip');
    if (++done % 100 === 0) console.log(`  ${done}/${files.length}`);
  }
}));
const res = await post('/ingest/commit', JSON.stringify({ gen, expected: files.length }), 'application/json');
console.log(`Publicat: ${JSON.stringify(await res.json())} in ${Math.round((Date.now() - t) / 1000)} s`);
