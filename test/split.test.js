// Exportul pe tari (src/export/split.js, cel din Convex) da exact fisierele exportului dintr-o singura baza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDb, importAll, tx } from '../src/local/db.js';
import { exportFiles, shardOf, TERM_SHARDS } from '../src/export/build.js';
import { splitExport, pack, unpack, gzJson } from '../src/export/split.js';
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
  assert.ok(JSON.parse(text(want.get('list/ALL/changes/30/all'))).rows?.length ?? JSON.parse(text(want.get('list/ALL/changes/30/all'))).length);
  const appFiles = [...want].filter(([k]) => k.startsWith('app/')).map(([, b]) => Object.values(JSON.parse(text(b)))).flat();
  assert.ok(appFiles.some((a) => a.changes.length === 60), 'un app cu limita de 60 de schimbari');
  assert.ok(appFiles.some((a) => a.estimates.length > 1 && a.keywords.length > 1));
  const page = (term) => JSON.parse(text(want.get(`term/${shardOf(term, TERM_SHARDS)}`)))[term];
  const old = page('old timer').countries.find((c) => c.country === 'US');
  assert.ok(old.lastSeen && old.history.length === 90 && old.history.every((h) => h.score === 0), 'istorie toata 0 in US');
  assert.equal(page('brand new idea').countries.find((c) => c.country === 'DE').topAppIds.length, 2, 'clasificat in DE, vazut doar in US');
});

test('pack/unpack: bucatile se citesc separat, fara sa dezarhivam tot', () => {
  const buf = pack([['a', gzJson({ x: 1 })], ['b/2', gzJson([1, 2, 3])], ['gol', gzJson({})]]);
  const u = unpack(buf);
  assert.deepEqual(u.names(), ['a', 'b/2', 'gol']);
  assert.deepEqual(u.json('b/2'), [1, 2, 3]);
  assert.deepEqual(u.json('a'), { x: 1 });
  assert.equal(u.json('lipsa'), undefined);
  assert.equal(u.has('gol'), true);
  assert.deepEqual(unpack(pack([])).names(), []);
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
