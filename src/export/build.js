// Exportul pentru varianta online (Vercel + Convex): toate raspunsurile interfetei, calculate o data pe zi
// din local.db si scrise ca fisiere JSON comprimate. Online nu ruleaza SQLite: browserul primeste fisierele
// gata facute si doar filtreaza (categorie, limita de randuri).
//
// Fisiere (cheie -> continut):
//   meta                                  stare + categorii + tari
//   list/<CC>/<view>/<variant>             listele (cuvinte noi, in crestere, nise, explozii...), categoria 'all'
//   terms                                 toate cuvintele vazute (pentru sugestiile din cautare)
//   term/<shard>                          pagina fiecarui cuvant (termView), grupate dupa hash
//   app/<shard>                           cuvintele, locurile in topuri, estimarile si schimbarile fiecarui app
import { gzipSync } from 'node:zlib';
import { COUNTRIES } from '../apple/clients.js';
import { genreName } from '../apple/genres.js';
import { makeViews, pickScore, histPoints } from '../local/views.js';
import { tx } from '../local/db.js';
import { marketEstimate } from '../metrics/niche.js';
import { shardOf, TERM_SHARDS, APP_SHARDS } from './shard.js';

export { shardOf, TERM_SHARDS, APP_SHARDS };

const ALL = [...COUNTRIES, 'ALL'];

// Variantele fiecarei liste (exact parametrii pe care ii trimite interfata), fara categorie si fara limita.
export function listVariants() {
  const out = [];
  for (const cc of ALL) {
    for (const p of [1, 7, 30]) for (const origin of ['appeared', 'discovered', 'all']) out.push([`list/${cc}/new/${p}/${origin}`, (v) => v.view({ name: 'new', country: cc, period: p, origin, limit: Infinity })]);
    for (const name of ['rising', 'falling']) for (const p of [7, 30]) out.push([`list/${cc}/${name}/${p}`, (v) => v.view({ name, country: cc, period: p, limit: Infinity })]);
    for (const name of ['top', 'gone']) out.push([`list/${cc}/${name}`, (v) => v.view({ name, country: cc, limit: Infinity })]);
    for (const p of [7, 14, 30]) out.push([`list/${cc}/niches/${p}`, (v) => v.nicheView({ country: cc, period: p, all: true, limit: Infinity })]);
    out.push([`list/${cc}/breakouts`, (v) => v.breakoutView({ country: cc, limit: Infinity })]);
    for (const p of [7, 14, 30]) for (const who of ['money', 'all']) out.push([`list/${cc}/changes/${p}/${who}`, (v) => v.changesView({ country: cc, period: p, who, limit: Infinity })]);
    for (const launched of [30, 90, 180, 365]) {
      for (const type of ['all', 'free', 'paid', 'grossing']) out.push([`list/${cc}/apps/charts/${launched}/${type}`, (v) => v.newApps({ country: cc, type, launched, source: 'charts', limit: Infinity })]);
      out.push([`list/${cc}/apps/feed/${launched}`, (v) => v.newApps({ country: cc, launched, source: 'feed', limit: Infinity })]);
    }
    out.push([`list/${cc}/themes`, (v) => v.themeView({ country: cc })]);
  }
  return out;
}

// Paginile app-urilor, scrise pe rand, fisier cu fisier (memoria nu creste cu numarul de app-uri):
// tabele temporare cu app-urile fiecarui fisier si cuvintele lor, apoi cate o citire pe fisier.
function* appShards(db, views, counter) {
  db.exec(`DROP TABLE IF EXISTS temp.app_ids; DROP TABLE IF EXISTS temp.app_kw;
    CREATE TEMP TABLE app_ids (id INTEGER PRIMARY KEY, shard INTEGER);
    CREATE TEMP TABLE app_kw (id INTEGER, ci INTEGER, term TEXT, position INTEGER, score INTEGER, classified_at TEXT, category INTEGER)`);
  const addId = db.prepare('INSERT OR IGNORE INTO temp.app_ids VALUES (?,?)');
  const add = (id) => addId.run(id, shardOf(id, APP_SHARDS));
  const addKw = db.prepare('INSERT INTO temp.app_kw VALUES (?,?,?,?,?,?,?)');
  const estimates = new Map(); // id -> [{country, perDay, ...}]
  tx(db, () => {
    COUNTRIES.forEach((cc, ci) => {
      const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=? AND complete=1').get(cc).d;
      const big = views.bigOf(cc);
      const score = db.prepare('SELECT term, score, score_adj FROM scores WHERE country=? AND date=?').all(cc, latest);
      const scoreOf = new Map(score.map((s) => [s.term, pickScore(big, s.term, s.score, s.score_adj)]));
      for (const r of db.prepare('SELECT term, top_app_ids, classified_at, category FROM class WHERE country=?').iterate(cc)) {
        JSON.parse(r.top_app_ids).forEach((id, i) => {
          add(id);
          addKw.run(id, ci, r.term, i + 1, scoreOf.get(r.term) ?? 0, r.classified_at, r.category);
        });
      }
      for (const [id, v] of views.velocity(cc).map) {
        if (v.perDay == null) continue;
        add(id);
        if (!estimates.has(id)) estimates.set(id, []);
        estimates.get(id).push({ country: cc, perDay: v.perDay, ...marketEstimate(v.perDay) });
      }
    });
    for (const r of db.prepare('SELECT DISTINCT id FROM app_hist').iterate()) add(r.id);
    for (const r of db.prepare('SELECT DISTINCT id FROM app_changes').iterate()) add(r.id);
  });
  db.exec('CREATE INDEX temp.app_ids_shard ON app_ids (shard); CREATE INDEX temp.app_kw_id ON app_kw (id)');

  const ids = db.prepare('SELECT id FROM temp.app_ids WHERE shard=? ORDER BY id');
  const kws = db.prepare(`SELECT k.* FROM temp.app_ids a JOIN temp.app_kw k ON k.id=a.id WHERE a.shard=?
    ORDER BY k.id, k.score DESC, k.position, k.ci, k.term`);
  const hist = db.prepare(`SELECT h.id, h.country, h.date, h.dl, h.gr, h.st, h.ratings FROM temp.app_ids a
    JOIN app_hist h ON h.id=a.id WHERE a.shard=? ORDER BY h.id, h.country, h.date`);
  const changes = db.prepare(`SELECT id, country, date, field, from_v "from", to_v "to", notes FROM app_changes
    WHERE id=? ORDER BY date DESC, rowid LIMIT 60`);
  try {
    for (let shard = 0; shard < APP_SHARDS; shard++) {
      const out = {};
      const keywords = new Map();
      for (const k of kws.iterate(shard)) {
        if (!keywords.has(k.id)) keywords.set(k.id, []);
        keywords.get(k.id).push({ country: COUNTRIES[k.ci], term: k.term, position: k.position, score: k.score, classifiedAt: k.classified_at, categoryName: genreName(k.category) });
      }
      const rows = new Map();
      for (const h of hist.iterate(shard)) {
        if (!rows.has(h.id)) rows.set(h.id, []);
        rows.get(h.id).push(h);
      }
      for (const { id } of ids.iterate(shard)) {
        out[id] = {
          keywords: keywords.get(id) ?? [],
          ranks: histPoints(rows.get(id) ?? []),
          estimates: estimates.get(id) ?? [],
          changes: changes.all(id).map(({ id: _, ...c }) => c),
        };
        counter.apps++;
      }
      yield [`app/${shard}`, out];
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.app_ids; DROP TABLE IF EXISTS temp.app_kw');
  }
}

// Exportul are 3 parti, fiecare calculabila separat (in Convex o parte poate continua intr-o alta actiune).
export const EXPORT_PARTS = ['lists', 'terms', 'apps'];

// Toate fisierele, pe rand ([cheie, gzip]): fiecare e calculat abia cand e cerut, deci memoria nu tine tot exportul.
export function* exportFiles(db, { log = console.log, cloud = null, parts = EXPORT_PARTS } = {}) {
  const views = makeViews(db);
  const gz = (obj) => gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 }); // 9 = de 2 ori mai lent pentru 5% mai mic

  if (parts.includes('lists')) {
    yield ['meta', gz({ generatedAt: new Date().toISOString(), countries: COUNTRIES, categories: views.categories(), status: views.status(), cloud })];
    const t = Date.now();
    for (const [key, fn] of listVariants()) yield [key, gz(fn(views))];
    views.forget();
    log(`liste: ${Date.now() - t} ms`);
  }

  if (parts.includes('terms')) {
    const t = Date.now();
    // Cuvintele vazute in zilele pastrate in baza (RETAIN.scores): cele disparute de mult nu mai au pagina.
    const since = db.prepare('SELECT MIN(date) d FROM scores').get().d ?? '';
    const terms = db.prepare('SELECT term FROM seen WHERE last_seen>=? GROUP BY term ORDER BY length(term), term').all(since).map((r) => r.term);
    yield ['terms', gz(terms)];
    const byShard = Array.from({ length: TERM_SHARDS }, () => []);
    for (const term of terms) byShard[shardOf(term, TERM_SHARDS)].push(term);
    for (let i = 0; i < TERM_SHARDS; i++) {
      const shard = {};
      for (const term of byShard[i]) shard[term] = views.termView(term);
      yield [`term/${i}`, gz(shard)];
    }
    log(`cuvinte: ${terms.length} in ${Date.now() - t} ms`);
  }

  if (parts.includes('apps')) {
    const t = Date.now();
    const counter = { apps: 0 };
    for (const [key, obj] of appShards(db, views, counter)) yield [key, gz(obj)];
    log(`app-uri: ${counter.apps} in ${Date.now() - t} ms`);
  }
}

// Scrie fiecare fisier prin `emit(key, buffer)`. Intoarce marimile, pentru jurnal.
export function buildExport(db, emit, opts = {}) {
  const sizes = { list: 0, term: 0, app: 0, other: 0, files: 0 };
  for (const [key, buf] of exportFiles(db, opts)) {
    sizes[key.split('/')[0]] = (sizes[key.split('/')[0]] ?? 0) + buf.length;
    sizes.files++;
    emit(key, buf);
  }
  return sizes;
}
