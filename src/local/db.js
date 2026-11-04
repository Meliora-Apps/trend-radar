// Baza SQLite de calcul: datele zilnice (fisierele din data/ sau din Convex) -> tabele pentru interfata.
// Tine doar cat trebuie interfetei (vezi RETAIN si prune), ca baza sa ramana mica si cand istoricul creste:
// fisierele zilnice raman sursa completa, baza e doar starea de calcul.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COUNTRIES, DOWNLOAD_TYPES } from '../apple/clients.js';
import { listDates, dayPath, classifyPath, appsPath, statsPath, changesPath, readJsonGzSafe } from '../data/files.js';
import { STATS_FIELDS } from '../collect/steps.js';
import { bestObservations, scoreDayAdjusted } from '../metrics/score.js';
import { addDays } from '../util/dates.js';

// Cat pastram (in zile) din fiecare tabela care creste zilnic.
export const RETAIN = {
  scores: 100, // zilele cu scoruri (graficul cuvantului arata 90 de zile complete; trendurile 45)
  charts: 10, // zilele cu topuri complete (temele: 8 zile; urcarea: fata de acum 7 zile)
  stats: 40, // cifrele complete ale app-urilor (ritmul: 14 zile; schimbarile de pret: 31)
  histDaily: 35, // graficele app-ului: zilnic in ultimele 35 de zile...
  hist: 182, // ...apoi o zi pe saptamana, pana la ~6 luni
  feed: 366, // lansarile noi (filtrul "lansate in ultimele 365 de zile")
  changes: 366, // schimbarile app-urilor (nume, versiune)
  upcoming: 120, // precomenzile vazute in cautari (prima aparitie, urcarea pe zile)
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imported (kind TEXT, date TEXT, country TEXT, size INTEGER,
  PRIMARY KEY (kind, date, country)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (country TEXT, date TEXT, complete INTEGER, requests INTEGER, errors INTEGER,
  PRIMARY KEY (country, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scores (country TEXT, date TEXT, term TEXT, score INTEGER, prefix TEXT, position INTEGER,
  score_adj INTEGER, PRIMARY KEY (country, date, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS seen (country TEXT, term TEXT, first_seen TEXT, last_seen TEXT,
  PRIMARY KEY (country, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS class (country TEXT, term TEXT, category INTEGER, subgenre INTEGER, difficulty INTEGER,
  top_app_ids TEXT, classified_at TEXT, niche TEXT, PRIMARY KEY (country, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS charts (country TEXT, date TEXT, type TEXT, genre_id INTEGER, rank INTEGER,
  app_id INTEGER, name TEXT, app_genre INTEGER);
CREATE INDEX IF NOT EXISTS charts_cd ON charts (country, date);
CREATE INDEX IF NOT EXISTS charts_app ON charts (app_id, country, date);
CREATE TABLE IF NOT EXISTS chart_first (country TEXT, app_id INTEGER, first_date TEXT,
  PRIMARY KEY (country, app_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS problems (path TEXT PRIMARY KEY, error TEXT);
CREATE TABLE IF NOT EXISTS app_meta (country TEXT, id INTEGER, name TEXT, genre_id INTEGER, release_date TEXT,
  seller TEXT, seen_at TEXT, PRIMARY KEY (country, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_names (country TEXT, id INTEGER, name TEXT, PRIMARY KEY (country, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS queried_first (country TEXT, prefix TEXT, first_date TEXT,
  PRIMARY KEY (country, prefix)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_stats (country TEXT, id INTEGER, date TEXT, ratings INTEGER, ratings_cur INTEGER,
  stars REAL, version TEXT, updated TEXT, price REAL, PRIMARY KEY (country, id, date)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_stats_cd ON app_stats (country, date);
CREATE TABLE IF NOT EXISTS app_hist (id INTEGER, country TEXT, date TEXT, dl INTEGER, gr INTEGER, st INTEGER, ratings INTEGER,
  PRIMARY KEY (id, country, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS new_feed (country TEXT, date TEXT, type TEXT, rank INTEGER, app_id INTEGER, name TEXT,
  app_genre INTEGER);
CREATE INDEX IF NOT EXISTS new_feed_cd ON new_feed (country, date);
CREATE TABLE IF NOT EXISTS app_changes (country TEXT, date TEXT, id INTEGER, field TEXT, from_v TEXT, to_v TEXT, notes TEXT);
CREATE INDEX IF NOT EXISTS app_changes_cd ON app_changes (country, date);
CREATE INDEX IF NOT EXISTS app_changes_id ON app_changes (id, date);
CREATE TABLE IF NOT EXISTS upcoming (country TEXT, date TEXT, id INTEGER, term TEXT, position INTEGER, name TEXT,
  seller TEXT, genre_id INTEGER, release_date TEXT, price REAL, pub INTEGER,
  PRIMARY KEY (country, date, id, term)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS upcoming_id ON upcoming (country, id, date);
`;
// 8 = baza de calcul compacta: tabele WITHOUT ROWID, istoric limitat (RETAIN), app_hist, chart_first,
//     queried_first, app_names. Bazele mai vechi se refac de la zero din fisierele zilnice.
const SCHEMA_VERSION = 8;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);
  return db;
}

export const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

function importDay(db, day) {
  const { country: cc, date } = day;
  const again = !!db.prepare('SELECT 1 FROM days WHERE country=? AND date=?').get(cc, date);
  db.prepare('DELETE FROM scores WHERE country=? AND date=?').run(cc, date);
  db.prepare('DELETE FROM charts WHERE country=? AND date=?').run(cc, date);
  db.prepare('DELETE FROM new_feed WHERE country=? AND date=?').run(cc, date);
  db.prepare('DELETE FROM upcoming WHERE country=? AND date=?').run(cc, date);
  const insUp = db.prepare('INSERT OR IGNORE INTO upcoming VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const u of day.upcoming ?? []) {
    for (const a of u.apps) insUp.run(cc, date, a.id, u.term, a.position, a.name, a.seller, a.genreId, a.releaseDate, a.price ?? 0, a.pub ?? 0);
  }
  const insFeed = db.prepare('INSERT INTO new_feed VALUES (?,?,?,?,?,?,?)');
  for (const f of day.newFeed ?? []) for (const a of f.apps) insFeed.run(cc, date, f.type, a.rank, a.id, a.name, a.genreId);
  const upQueried = db.prepare(`INSERT INTO queried_first VALUES (?,?,?) ON CONFLICT (country, prefix) DO UPDATE SET
    first_date = MIN(first_date, excluded.first_date)`);
  for (const s of day.suggest ?? []) if (s.kind === 'expand') upQueried.run(cc, s.prefix, date);
  db.prepare('INSERT OR REPLACE INTO days VALUES (?,?,?,?,?)')
    .run(cc, date, day.complete ? 1 : 0, day.requests ?? 0, day.errors ?? 0);
  const insScore = db.prepare('INSERT INTO scores VALUES (?,?,?,?,?,?,?)');
  const adj = scoreDayAdjusted(day.suggest ?? []);
  const upSeen = db.prepare(`INSERT INTO seen VALUES (?,?,?,?) ON CONFLICT (country, term) DO UPDATE SET
    first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`);
  for (const [term, o] of bestObservations(day.suggest ?? [])) {
    insScore.run(cc, date, term, o.score, o.prefix, o.position, adj.get(term) ?? o.score);
    upSeen.run(cc, term, date, date);
  }
  const insChart = db.prepare('INSERT INTO charts VALUES (?,?,?,?,?,?,?,?)');
  const upFirst = db.prepare(`INSERT INTO chart_first VALUES (?,?,?) ON CONFLICT (country, app_id) DO UPDATE SET
    first_date = MIN(first_date, excluded.first_date)`);
  const best = new Map(); // id -> { dl, gr }: cel mai bun loc al zilei (descarcari / incasari), pentru grafice
  for (const c of day.charts ?? []) {
    const kind = DOWNLOAD_TYPES.includes(c.type) ? 'dl' : c.type === 'topgrossingapplications' ? 'gr' : null;
    for (const a of c.apps) {
      insChart.run(cc, date, c.type, c.genreId, a.rank, a.id, a.name, a.genreId);
      upFirst.run(cc, a.id, date);
      if (!kind) continue;
      const b = best.get(a.id) ?? { dl: null, gr: null };
      if (b[kind] == null || a.rank < b[kind]) b[kind] = a.rank;
      best.set(a.id, b);
    }
  }
  // Ziua reimportata (fisier schimbat): locurile vechi ale zilei se sterg inainte (cauta in toata tabela, dar e rar).
  if (again) db.prepare('UPDATE app_hist SET dl=NULL, gr=NULL WHERE country=? AND date=?').run(cc, date);
  const upHist = db.prepare(`INSERT INTO app_hist (id, country, date, dl, gr) VALUES (?,?,?,?,?)
    ON CONFLICT (id, country, date) DO UPDATE SET dl=excluded.dl, gr=excluded.gr`);
  for (const [id, b] of best) upHist.run(id, cc, date, b.dl, b.gr);
}

function importClassify(db, cc, file) {
  const up = db.prepare('INSERT OR REPLACE INTO class VALUES (?,?,?,?,?,?,?,?)');
  for (const [term, c] of Object.entries(file)) {
    up.run(cc, term, c.category, c.subgenre ?? null, c.difficulty ?? null,
      JSON.stringify(c.topAppIds ?? []), c.classifiedAt, c.niche ? JSON.stringify(c.niche) : null);
  }
}

function importApps(db, cc, file) {
  const up = db.prepare('INSERT OR REPLACE INTO app_meta VALUES (?,?,?,?,?,?,?)');
  const name = db.prepare('INSERT OR IGNORE INTO app_names VALUES (?,?,?)');
  for (const [id, m] of Object.entries(file)) {
    up.run(cc, Number(id), m.name ?? '', m.genreId ?? null, m.releaseDate ?? null, m.seller ?? '', m.seenAt ?? null);
    if (m.name) name.run(cc, Number(id), m.name);
  }
}

function importStats(db, cc, file, date) {
  const up = db.prepare('INSERT OR REPLACE INTO app_stats VALUES (?,?,?,?,?,?,?,?,?)');
  const upHist = db.prepare(`INSERT INTO app_hist (id, country, date, st, ratings) VALUES (?,?,?,1,?)
    ON CONFLICT (id, country, date) DO UPDATE SET st=1, ratings=excluded.ratings`);
  const at = (row, f) => row[STATS_FIELDS.indexOf(f)] ?? null;
  for (const [id, row] of Object.entries(file)) {
    up.run(cc, Number(id), date, at(row, 'ratings'), at(row, 'ratingsCur'), at(row, 'stars'), at(row, 'version'), at(row, 'updated'), at(row, 'price'));
    upHist.run(Number(id), cc, date, at(row, 'ratings'));
  }
}

function importChanges(db, cc, file, date) {
  db.prepare('DELETE FROM app_changes WHERE country=? AND date=?').run(cc, date);
  const ins = db.prepare('INSERT INTO app_changes VALUES (?,?,?,?,?,?,?)');
  const rename = db.prepare(`INSERT INTO app_names VALUES (?,?,?) ON CONFLICT (country, id) DO UPDATE SET name=excluded.name`);
  for (const c of file) {
    ins.run(cc, date, Number(c.id), c.field, c.from ?? null, c.to ?? null, c.notes ?? null);
    if (c.field === 'name' && c.to) rename.run(cc, Number(c.id), c.to);
  }
}

export const KINDS = ['days', 'classify', 'apps', 'stats', 'changes'];
const IMPORTERS = {
  days: (db, cc, v) => importDay(db, v),
  classify: importClassify,
  apps: importApps,
  stats: importStats,
  changes: importChanges,
};

// Un fisier zilnic deja citit. `size` = marimea fisierului (acelasi fisier nu se reimporta).
export function importFile(db, { kind, date, country, value, size }) {
  tx(db, () => {
    IMPORTERS[kind](db, country, value, date);
    db.prepare('INSERT OR REPLACE INTO imported VALUES (?,?,?,?)').run(kind, date, country, size);
  });
}
export const isImported = (db, { kind, date, country, size }) =>
  db.prepare('SELECT size FROM imported WHERE kind=? AND date=? AND country=?').get(kind, date, country)?.size === size;

const PATHS = { days: dayPath, classify: classifyPath, apps: appsPath, stats: statsPath, changes: changesPath };

// Importa din data/ doar fisierele noi sau schimbate (dupa marime). Fisierele stricate ajung in `problems`.
export function importAll(db, dataDir, { prune: doPrune = true } = {}) {
  const stats = { days: 0, classify: 0, apps: 0, stats: 0, changes: 0, problems: 0 };
  const problem = db.prepare('INSERT OR REPLACE INTO problems VALUES (?,?)');
  for (const kind of KINDS) {
    for (const date of listDates(dataDir, kind)) {
      for (const country of COUNTRIES) {
        const file = PATHS[kind](dataDir, date, country);
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        if (isImported(db, { kind, date, country, size })) continue;
        const r = readJsonGzSafe(file);
        if (!r.ok) {
          problem.run(path.relative(dataDir, file), r.error);
          stats.problems++;
          continue;
        }
        importFile(db, { kind, date, country, value: r.value, size });
        stats[kind]++;
      }
    }
  }
  if (doPrune) prune(db);
  return stats;
}

// Sterge ce nu mai foloseste interfata (vezi RETAIN), pe fiecare tara, fata de ultima zi colectata.
export function prune(db) {
  tx(db, () => {
    for (const cc of COUNTRIES) {
      const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=?').get(cc).d;
      if (!latest) continue;
      const nth = (sql, n) => db.prepare(`${sql} ORDER BY date DESC LIMIT 1 OFFSET ?`).get(cc, n - 1)?.date ?? null;
      const scoresFrom = nth('SELECT date FROM days WHERE country=?', RETAIN.scores);
      if (scoresFrom) db.prepare('DELETE FROM scores WHERE country=? AND date<?').run(cc, scoresFrom);
      const chartsFrom = nth('SELECT DISTINCT date FROM charts WHERE country=?', RETAIN.charts);
      if (chartsFrom) db.prepare('DELETE FROM charts WHERE country=? AND date<?').run(cc, chartsFrom);
      db.prepare('DELETE FROM app_stats WHERE country=? AND date<?').run(cc, addDays(latest, -RETAIN.stats));
      db.prepare('DELETE FROM new_feed WHERE country=? AND date<?').run(cc, addDays(latest, -RETAIN.feed));
      db.prepare('DELETE FROM app_changes WHERE country=? AND date<?').run(cc, addDays(latest, -RETAIN.changes));
      db.prepare('DELETE FROM upcoming WHERE country=? AND date<?').run(cc, addDays(latest, -RETAIN.upcoming));
      db.prepare(`DELETE FROM app_hist WHERE country=? AND (date<? OR (date<? AND CAST(julianday(date) AS INTEGER) % 7 != 0))`)
        .run(cc, addDays(latest, -RETAIN.hist), addDays(latest, -RETAIN.histDaily));
    }
  });
}
