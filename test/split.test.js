// Exportul pe tari (src/export/split.js, cel din Convex) da exact fisierele exportului dintr-o singura baza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openDb, importAll, tx } from '../src/local/db.js';
import { makeViews } from '../src/local/views.js';
import { exportFiles, shardOf, TERM_SHARDS } from '../src/export/build.js';
import { splitExport, countryParts, pack, unpack, gzJson, piece, fromPiece, LIST_GROUPS } from '../src/export/split.js';
import { CHANGE_FILES } from '../src/export/changes.js';
import { compactCopy, packStream, unpackStream, copyValue, copyDue, COPY_FORMAT, COPY_DAYS } from '../src/export/dbcopy.js';
import { makeRemoteApi } from '../web/remote-api.js';
import { writeJsonGz, dayPath, classifyPath, appsPath, statsPath, changesPath } from '../src/data/files.js';
import { nicheStats } from '../src/metrics/niche.js';
import { COUNTRIES, CHART_TYPES, NEW_FEEDS } from '../src/apple/clients.js';
import { addDays } from '../src/util/dates.js';

// Numere pseudo-aleatoare, aceleasi la fiecare rulare.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const WORDS = ['ai baby', 'ai photo', 'amazon', 'airbnb', 'baby face', 'baby names', 'banking', 'bible', 'calm', 'car game',
  'chess', 'chat ai', 'dating', 'diet', 'piano', 'puzzle', 'photo editor', 'vpn', 'weather', '2048', 'écran', 'über', 'ai'];

// Trei tari cu date (US, GB, DE: aceleasi cuvinte si app-uri in mai multe tari, zile lipsa, un fisier stricat),
// trei fara nimic (FR, IT, ES).
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trs-'));
  const rand = rng(7);
  const pick = (arr, n) => [...arr].sort(() => rand() - 0.5).slice(0, n);
  const apps = Array.from({ length: 36 }, (_, i) => ({
    id: 1000 + i * 37, name: `${WORDS[i % WORDS.length]} ${['Pro', 'Maker', 'Lite', 'AI'][i % 4]}`,
    genreId: [6008, 6014, 6005, 6012][i % 4], seller: `Studio ${i % 5}`, releaseDate: addDays('2025-10-01', i * 4),
  }));
  const DAYS = 20;
  for (const [ci, cc] of ['US', 'GB', 'DE'].entries()) {
    const ratings = new Map(apps.map((a, i) => [a.id, 50 + i * 30 + ci * 7]));
    for (let d = 0; d < DAYS; d++) {
      const date = addDays('2026-01-01', d);
      if (cc === 'DE' && d === 4) continue; // zi lipsa
      // Cuvintele: fiecare tara vede o parte, unele apar abia spre final (cuvinte noi), altele dispar.
      const visible = WORDS.filter((w, i) => (i + ci) % 4 !== 0 || d >= DAYS - 3).filter((w, i) => !(i % 7 === ci && d >= DAYS - 4));
      const suggest = ['a', 'b', 'c', 'p'].map((prefix) => ({
        prefix, kind: 'base', terms: pick(visible.filter((w) => w.startsWith(prefix) || rand() < 0.15), 6),
      }));
      suggest.push({ prefix: 'ai ', kind: 'expand', terms: pick(visible.filter((w) => w.startsWith('ai')), 3) });
      if (cc === 'US' && d === DAYS - 1) suggest.push({ prefix: 'nou', kind: 'expand', terms: ['brand new idea'] });
      const charts = [];
      for (const type of CHART_TYPES) {
        for (const genreId of [6008, 6014]) {
          const pool = apps.filter((a) => a.genreId === genreId || rand() < 0.2).filter((a, i) => d >= 12 || i % 3 !== 0);
          charts.push({ type, genreId, apps: pick(pool, 8).map((a, i) => ({ rank: i + 1, id: a.id, name: a.name, genreId: a.genreId })) });
        }
      }
      const newFeed = NEW_FEEDS.map((type) => ({ type, apps: pick(apps.slice(20), 5).map((a, i) => ({ rank: i + 1, id: a.id, name: a.name, genreId: a.genreId })) }));
      const upcoming = d >= DAYS - 5 ? [{ term: 'game', apps: pick(apps.filter((a) => a.genreId === 6014), 3).map((a, i) => ({
        id: a.id + 5, position: i + 1, name: `${a.name} Next`, seller: a.seller, genreId: 6014, releaseDate: addDays(date, 20 + i), price: 0, pub: i,
      })) }] : [];
      writeJsonGz(dayPath(dir, date, cc), {
        date, country: cc, complete: !(cc === 'GB' && d === 9), requests: 100, errors: 1, suggest, charts, newFeed, upcoming,
      });

      // Rating-urile cresc in ritmuri diferite; cateva app-uri explodeaza in ultimele zile.
      const stats = {};
      for (const [i, a] of apps.entries()) {
        if (i % 5 === 4 && d < 6) continue;
        ratings.set(a.id, ratings.get(a.id) + (i % 6) * 3 + (i % 9 === 0 && d >= DAYS - 3 ? 400 : 0) + Math.floor(rand() * 4));
        stats[a.id] = [ratings.get(a.id), Math.floor(ratings.get(a.id) / 3), 4 + (i % 10) / 10, `1.${Math.floor(d / 5)}`, addDays(date, -(i % 30)), i % 7 === 0 ? 2.99 : 0];
      }
      writeJsonGz(statsPath(dir, date, cc), stats);
      if (d % 6 === 0) {
        writeJsonGz(appsPath(dir, date, cc), Object.fromEntries(apps.map((a) => [a.id, { name: a.name, genreId: a.genreId, releaseDate: a.releaseDate, seller: a.seller, seenAt: date }])));
      }
      if (d % 3 === 1) {
        // Schimbari: acelasi app in mai multe tari in aceeasi zi; un app cu multe schimbari (limita de 60).
        const changes = pick(apps, 4).map((a) => ({ id: a.id, field: 'version', from: '1.0', to: `1.${d}`, notes: `fix ${cc} ${d}` }));
        changes.push({ id: apps[1].id, field: 'name', from: apps[1].name, to: `${apps[1].name} ${d}`, notes: null });
        for (let k = 0; k < 12; k++) changes.push({ id: apps[2].id, field: 'price', from: String(k), to: String(k + 1), notes: null });
        writeJsonGz(changesPath(dir, date, cc), changes);
      }
      if (d % 5 === 3 || d === DAYS - 1) {
        const classify = {};
        for (const term of pick(visible, 6)) {
          const top = pick(apps, 10);
          const rows = top.map((a) => ({ name: a.name, ratings: ratings.get(a.id), stars: 4.2, releaseDate: a.releaseDate, updated: date }));
          classify[term] = {
            category: term.includes('game') || term === 'chess' ? 6014 : term.startsWith('ai') ? 6008 : [6005, 6012, 0][d % 3], subgenre: term === 'chess' ? 7002 : null,
            difficulty: d % 3, topAppIds: top.map((a) => a.id), classifiedAt: date, niche: nicheStats(rows, term, date),
          };
        }
        // Clasificat, dar niciodata vazut in sugestiile tarii (cuvintele fixe pentru precomenzi); unul e vazut in US.
        if (cc === 'GB') classify['zz only classified'] = { category: 6014, subgenre: null, difficulty: 2, topAppIds: [apps[3].id], classifiedAt: date };
        if (cc === 'DE' && d === DAYS - 1) classify['brand new idea'] = { category: 6008, subgenre: null, difficulty: 0, topAppIds: [apps[5].id, apps[6].id], classifiedAt: date };
        writeJsonGz(classifyPath(dir, date, cc), classify);
      }
    }
  }
  // US are si 100 de zile mai vechi: 'old timer' e vazut acolo doar la inceput (istoria lui de 90 de zile in US
  // e toata 0), dar in GB e vazut acum, deci are pagina.
  for (let d = 1; d <= 100; d++) {
    const date = addDays('2026-01-01', -d);
    writeJsonGz(dayPath(dir, date, 'US'), {
      date, country: 'US', complete: true, requests: 10, errors: 0,
      suggest: [{ prefix: 'o', kind: 'base', terms: d > 95 ? ['old timer', 'ocean'] : ['ocean'] }],
    });
  }
  for (let d = 15; d < DAYS; d++) {
    const date = addDays('2026-01-01', d);
    writeJsonGz(dayPath(dir, date, 'GB'), (() => {
      const day = JSON.parse(gunzipSync(fs.readFileSync(dayPath(dir, date, 'GB'))).toString());
      day.suggest.push({ prefix: 'o', kind: 'base', terms: ['old timer'] });
      return day;
    })());
  }
  fs.writeFileSync(dayPath(dir, '2026-01-08', 'GB'), 'nu e gzip');
  return dir;
}

const text = (buf) => gunzipSync(buf).toString('utf8');

test('exportul pe tari = exportul dintr-o singura baza (aceleasi chei, acelasi JSON)', () => {
  const dir = fixture();
  const cloud = { lastRun: '2026-01-20', finishedAt: '2026-01-20T10:00:00.000Z', countries: {} };
  const one = openDb();
  importAll(one, dir);
  const want = new Map(exportFiles(one, { log: () => {}, cloud }));

  const dbs = new Map(COUNTRIES.map((cc) => {
    const db = openDb();
    importAll(db, dir, { countries: [cc] });
    return [cc, db];
  }));
  const got = new Map(splitExport(dbs, { cloud }));

  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort());
  const meta = (buf) => { const m = JSON.parse(text(buf)); delete m.generatedAt; return JSON.stringify(m); };
  for (const [key, buf] of want) {
    if (key === 'meta') assert.equal(meta(got.get(key)), meta(buf), key);
    else assert.equal(text(got.get(key)), text(buf), key);
  }
  // Fixture-ul chiar acopera ce compara: liste pline, cuvinte cu istorie, app-uri cu de toate, o problema.
  const m = JSON.parse(text(want.get('meta')));
  assert.equal(m.status.problems.length, 1);
  assert.ok(JSON.parse(text(want.get('list/ALL/new/7/all'))).rows.length > 0);
  assert.ok(JSON.parse(text(want.get('list/ALL/changes/30/all'))).rows.length > 0);
  const appFiles = [...want].filter(([k]) => k.startsWith('app/')).map(([, b]) => Object.values(JSON.parse(text(b)))).flat();
  assert.ok(appFiles.some((a) => a.changes.length === 60), 'un app cu limita de 60 de schimbari');
  assert.ok(appFiles.some((a) => a.estimates.length > 1 && a.keywords.length > 1));
  const page = (term) => JSON.parse(text(want.get(`term/${shardOf(term, TERM_SHARDS)}`)))[term];
  const old = page('old timer').countries.find((c) => c.country === 'US');
  assert.ok(old.lastSeen && old.history.length === 90 && old.history.every((h) => h.score === 0), 'istorie toata 0 in US');
  assert.equal(page('brand new idea').countries.find((c) => c.country === 'DE').topAppIds.length, 2, 'clasificat in DE, vazut doar in US');
});

test('pack/unpack: bucatile se citesc separat, fara sa dezarhivam tot (brotli, si gzip de la calculele vechi)', () => {
  const buf = pack([['a', piece({ x: 1 })], ['b/2', piece([1, 2, 3])], ['gol', piece({})], ['vechi', gzJson({ g: 'ă' })]]);
  const u = unpack(buf);
  assert.deepEqual(u.names(), ['a', 'b/2', 'gol', 'vechi']);
  assert.deepEqual(u.json('b/2'), [1, 2, 3]);
  assert.deepEqual(u.json('a'), { x: 1 });
  assert.deepEqual(u.json('vechi'), { g: 'ă' });
  assert.equal(u.json('lipsa'), undefined);
  assert.equal(u.has('gol'), true);
  assert.deepEqual(unpack(pack([])).names(), []);
  // Brotli nu incepe niciodata ca gzip (fereastra 22), deci formatul se recunoaste dupa primii octeti.
  for (const v of [{}, [], 'x', { a: 'ă'.repeat(5000) }, Array.from({ length: 3000 }, (_, i) => i)]) {
    assert.notDeepEqual([...piece(v).subarray(0, 2)], [0x1f, 0x8b]);
    assert.deepEqual(fromPiece(piece(v)), v);
    assert.deepEqual(fromPiece(gzipSync(JSON.stringify(v))), v);
  }
});

test('bucatile listelor, pe grupe: fiecare grupa are exact bucatile listelor ei (si ale celor ALL din grupa)', () => {
  const dir = fixture();
  const db = openDb();
  importAll(db, dir, { countries: ['US'] });
  const memo = new Map();
  for (const [kind, key, buf] of countryParts(db, 'US')) if (kind === 'piece' && key.startsWith('memo/')) memo.set(key, unpack(buf));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual([...memo.keys()], LIST_GROUPS.map((_, g) => `memo/US/${g}`));
  const names = (g) => memo.get(`memo/US/${g}`).names();
  assert.ok(names(0).every((k) => k === 'meta:US' || k.startsWith('view:US:new:')), names(0).join());
  assert.ok(names(1).includes('meta:US') && !names(1).some((k) => k.startsWith('view:US:new:')));
  assert.deepEqual([...new Set(names(2).map((k) => k.split(':')[0]))], ['niches']);
  assert.deepEqual([...new Set(names(3).map((k) => k.split(':')[0]))].sort(), ['breakouts', 'changes']);
  assert.deepEqual(names(3).filter((k) => k.startsWith('changes:')), ['changes:US:30'], 'o singura bucata a schimbarilor (30 de zile)');
  assert.ok(!LIST_GROUPS.some((_, g) => names(g).some((k) => k.startsWith('trend:'))));
});

// Fisierele unui export servite ca in Convex (data:urls -> adrese), pentru web/remote-api.js.
globalThis.location ??= { origin: 'http://test' };
const siteOf = (files) => makeRemoteApi({
  query: async (name, { keys }) => ({ gen: 'g1', urls: keys.map((k) => (files.has(k) ? `data:application/gzip;base64,${files.get(k).toString('base64')}` : null)) }),
  action: async () => [],
}).api;

test('online = local pentru variantele fara fisier: schimbarile (7/14/30 zile, toti / cei care fac bani) si cuvintele descoperite', async () => {
  const dir = fixture();
  const one = openDb();
  importAll(one, dir);
  const views = makeViews(one);
  const dbs = new Map(COUNTRIES.map((cc) => {
    const db = openDb();
    importAll(db, dir, { countries: [cc] });
    return [cc, db];
  }));
  const files = new Map(splitExport(dbs, {}));
  fs.rmSync(dir, { recursive: true, force: true });
  const api = siteOf(files);
  const strip = (r) => JSON.parse(JSON.stringify(r));
  for (const cc of ['US', 'DE', 'FR', 'ALL']) {
    assert.deepEqual(CHANGE_FILES.map(([p, who]) => files.has(`list/${cc}/changes/${p}/${who}`)), [true, true]);
    assert.ok(!files.has(`list/${cc}/changes/14/all`) && !files.has(`list/${cc}/new/7/discovered`));
    for (const p of [7, 14, 30]) {
      for (const who of ['all', 'money']) {
        for (const category of ['all', '6014']) {
          const want = views.changesView({ country: cc, period: p, who, category });
          const got = await api(`/api/changes?country=${cc}&period=${p}&who=${who}&category=${category}`);
          assert.deepEqual(got, strip({ total: want.total, rows: want.rows }), `${cc} ${p} ${who} ${category}`);
        }
      }
    }
    for (const p of [1, 7, 30]) {
      for (const origin of ['appeared', 'discovered', 'all']) {
        const got = await api(`/api/view?name=new&country=${cc}&period=${p}&origin=${origin}&category=all`);
        assert.deepEqual(got, strip(views.view({ name: 'new', country: cc, period: p, origin })), `${cc} new ${p} ${origin}`);
      }
    }
  }
  // Fixture-ul acopera ce compara: perioadele chiar difera, iar "fac bani" e o parte.
  const count = (p, who) => views.changesView({ country: 'ALL', period: p, who, limit: Infinity }).total;
  assert.ok(count(7, 'all') < count(14, 'all') && count(14, 'all') < count(30, 'all'), [7, 14, 30].map((p) => count(p, 'all')).join());
  assert.ok(count(7, 'money') > 0 && count(7, 'money') < count(7, 'all'));
  assert.ok(views.view({ name: 'new', country: 'ALL', period: 30, origin: 'discovered' }).total > 0);
  // Perioada de 7 zile incepe cu a 7-a zi cu cifre de la final (ziua de dinainte da doar pretul de comparat).
  const days = one.prepare("SELECT DISTINCT date FROM app_stats WHERE country='US' ORDER BY date DESC").all().map((r) => r.date);
  const full = JSON.parse(text(files.get('list/US/changes/30/all')));
  assert.equal(full.since.US[7], days[6]);
  assert.equal(full.since.US[30], days.at(-2));

  // Un export de dinainte (fara `since`, cu fiecare varianta in fisierul ei) se citeste in continuare.
  const old = new Map(files);
  const { since, ...rest } = full;
  old.set('list/US/changes/30/all', gzJson(rest));
  old.set('list/US/changes/14/money', gzJson(views.changesView({ country: 'US', period: 14, who: 'money', limit: Infinity })));
  const want = views.changesView({ country: 'US', period: 14, who: 'money' });
  assert.deepEqual(await siteOf(old)('/api/changes?country=US&period=14&who=money&category=all'), strip({ total: want.total, rows: want.rows }));
});

test('copia bazei: compacta, fara indexuri, brotli; la restaurare aceleasi date si indexurile refacute', async () => {
  const dir = fixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  try {
    const file = path.join(work, 'US.db');
    const db = openDb(file);
    importAll(db, dir, { countries: ['US'] });
    const out = path.join(work, 'copy.db');
    const bytes = compactCopy(db, out);
    assert.equal(bytes, fs.statSync(out).size);
    const raw = new DatabaseSync(out, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL").get().n, 0);
    raw.close();
    await pipeline(fs.createReadStream(out), packStream(), fs.createWriteStream(`${out}.br`));
    const back = path.join(work, 'back.db');
    await pipeline(fs.createReadStream(`${out}.br`), unpackStream(COPY_FORMAT), fs.createWriteStream(back));
    const restored = openDb(back);
    const schema = (d) => d.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(schema(restored), schema(db));
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const n = db.prepare('SELECT COUNT(*) n FROM pragma_table_info(?)').get(name).n;
      const q = `SELECT * FROM "${name}" ORDER BY ${Array.from({ length: n }, (_, i) => i + 1).join(',')}`;
      assert.deepEqual(restored.prepare(q).all(), db.prepare(q).all(), name);
    }
    assert.ok(restored.prepare('SELECT COUNT(*) n FROM scores').get().n > 0);
    // Copiile vechi (gzip, fara format) se citesc in continuare.
    const gz = path.join(work, 'old.db');
    fs.writeFileSync(`${gz}.gz`, gzipSync(fs.readFileSync(back)));
    await pipeline(fs.createReadStream(`${gz}.gz`), unpackStream(undefined), fs.createWriteStream(gz));
    assert.ok(fs.readFileSync(gz).equals(fs.readFileSync(back)));
    db.close();
    restored.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copia bazei se rescrie doar cand trebuie (refacuta, format vechi, sau la COPY_DAYS zile)', () => {
  const v = copyValue(1000, '2026-01-10');
  assert.deepEqual(v, { bytes: 1000, format: COPY_FORMAT, latest: '2026-01-10' });
  assert.equal(copyDue(v, '2026-01-10', { restored: true }), false);
  assert.equal(copyDue(v, addDays('2026-01-10', COPY_DAYS - 1), { restored: true }), false);
  assert.equal(copyDue(v, addDays('2026-01-10', COPY_DAYS), { restored: true }), true);
  assert.equal(copyDue(v, '2026-01-11', { restored: false }), true, 'baza refacuta din arhiva');
  assert.equal(copyDue({ bytes: 1000 }, '2026-01-10', { restored: true }), true, 'copie gzip (formatul vechi)');
  assert.equal(copyDue(null, '2026-01-10', { restored: true }), true);
  assert.equal(copyDue({ format: COPY_FORMAT }, '2026-01-10', { restored: true }), true, 'fara ziua copiei');
});

test('tx: eroarea SQLite ramane cea adevarata cand tranzactia a fost deja anulata (disc plin)', () => {
  const db = openDb();
  db.exec('CREATE TABLE big (v TEXT)');
  const pages = db.prepare('PRAGMA page_count').get().page_count;
  db.exec(`PRAGMA max_page_count = ${pages + 2}`);
  const ins = db.prepare('INSERT INTO big VALUES (?)');
  assert.throws(() => tx(db, () => { for (let i = 0; i < 1000; i++) ins.run('x'.repeat(4000)); }), /full/);
  assert.throws(() => tx(db, () => { db.exec('ROLLBACK'); throw new Error('plin'); }), /^Error: plin$/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM big').get().n, 0);
  db.exec('BEGIN; COMMIT'); // nicio tranzactie ramasa deschisa
});
