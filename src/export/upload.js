// Incarca in arhiva din Convex fisierele zilnice din data/ care lipsesc acolo (sau difera), apoi cere recalcularea.
// Pentru mutarea istoricului si pentru o zi colectata de pe alt calculator (node src/collect/cli.js).
//   CONVEX_SITE_URL=https://<deployment>.convex.site INGEST_SECRET=... node src/export/upload.js [--from YYYY-MM-DD] [--no-process]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from '../apple/clients.js';
import { listDates, dayPath, classifyPath, appsPath, statsPath, changesPath } from '../data/files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = process.env.CONVEX_SITE_URL?.replace(/\/$/, '');
const SECRET = process.env.INGEST_SECRET;
const PARALLEL = 6;
const PATHS = { days: dayPath, classify: classifyPath, apps: appsPath, stats: statsPath, changes: changesPath };

const { values } = parseArgs({ options: { from: { type: 'string' }, data: { type: 'string' }, 'no-process': { type: 'boolean', default: false } } });
if (!SITE || !SECRET) {
  console.error('Lipsesc CONVEX_SITE_URL si/sau INGEST_SECRET.');
  process.exit(1);
}
const DATA = values.data ?? path.join(ROOT, 'data');
const auth = { authorization: `Bearer ${SECRET}` };

async function call(route, opts = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${SITE}${route}`, { ...opts, headers: { ...auth, ...opts.headers } });
    if (res.ok) return res;
    if (i >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${route}: HTTP ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
}

const have = new Map((await (await call('/ingest/raw-list')).json()).map((r) => [`${r.kind}/${r.date}/${r.country}`, r.size]));
const todo = [];
for (const kind of Object.keys(PATHS)) {
  for (const date of listDates(DATA, kind)) {
    if (values.from && date < values.from) continue;
    for (const country of COUNTRIES) {
      const file = PATHS[kind](DATA, date, country);
      if (!fs.existsSync(file)) continue;
      if (have.get(`${kind}/${date}/${country}`) === fs.statSync(file).size) continue;
      todo.push({ kind, date, country, file });
    }
  }
}
console.log(`De incarcat: ${todo.length} fisiere (${have.size} deja in arhiva)`);

let next = 0;
let done = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < todo.length) {
    const { kind, date, country, file } = todo[next++];
    await call(`/ingest/raw?kind=${kind}&date=${date}&country=${country}`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: fs.readFileSync(file) });
    if (++done % 50 === 0) console.log(`  ${done}/${todo.length}`);
  }
}));
console.log(`Incarcate: ${done}`);

if (!values['no-process']) {
  const latest = listDates(DATA, 'days').at(-1);
  console.log(JSON.stringify(await (await call('/ingest/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: latest }) })).json()));
  console.log('Calculul ruleaza in Convex (~5 minute); starea: npx convex logs');
}
