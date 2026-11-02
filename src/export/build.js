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
import { COUNTRIES, DOWNLOAD_TYPES } from '../apple/clients.js';
import { genreName } from '../apple/genres.js';
import { makeViews, pickScore } from '../local/views.js';
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

// Pagina fiecarui app, pentru toate app-urile deodata (o citire per tabela, nu una per app).
function appPages(db, views) {
  const pages = new Map();
  const page = (id) => {
    if (!pages.has(id)) pages.set(id, { keywords: [], ranks: { downloads: {}, grossing: {}, ratings: {} }, estimates: [], changes: [] });
    return pages.get(id);
  };
  for (const cc of COUNTRIES) {
    const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=? AND complete=1').get(cc).d;
    const big = views.bigOf(cc);
    const score = db.prepare('SELECT term, score, score_adj FROM scores WHERE country=? AND date=?').all(cc, latest);
    const scoreOf = new Map(score.map((s) => [s.term, pickScore(big, s.term, s.score, s.score_adj)]));
    for (const r of db.prepare('SELECT term, top_app_ids, classified_at, category FROM class WHERE country=?').iterate(cc)) {
      JSON.parse(r.top_app_ids).forEach((id, i) => page(id).keywords.push({
        country: cc, term: r.term, position: i + 1, score: scoreOf.get(r.term) ?? 0, classifiedAt: r.classified_at, categoryName: genreName(r.category),
      }));
    }
    const ranks = db.prepare(`SELECT app_id id, date, type, MIN(rank) r FROM charts WHERE country=? GROUP BY app_id, date,
      CASE WHEN type='topgrossingapplications' THEN 'g' ELSE 'd' END ORDER BY date`);
    for (const r of ranks.iterate(cc)) {
      const kind = DOWNLOAD_TYPES.includes(r.type) ? 'downloads' : 'grossing';
      (page(r.id).ranks[kind][cc] ??= []).push({ date: r.date, score: r.r });
    }
    for (const r of db.prepare('SELECT id, date, ratings FROM app_stats WHERE country=? ORDER BY date').iterate(cc)) {
      (page(r.id).ranks.ratings[cc] ??= []).push({ date: r.date, score: r.ratings });
    }
    for (const [id, v] of views.velocity(cc).map) {
      if (v.perDay != null) page(id).estimates.push({ country: cc, perDay: v.perDay, ...marketEstimate(v.perDay) });
    }
  }
  for (const c of db.prepare('SELECT id, country, date, field, from_v "from", to_v "to", notes FROM app_changes ORDER BY date DESC').iterate()) {
    const p = page(c.id);
    if (p.changes.length < 60) p.changes.push({ country: c.country, date: c.date, field: c.field, from: c.from, to: c.to, notes: c.notes });
  }
  // Aceeasi forma ca /api/app: cuvintele sortate, locurile pe tari (toate tarile, si cele fara puncte).
  for (const p of pages.values()) {
    p.keywords.sort((a, b) => b.score - a.score || a.position - b.position);
    for (const kind of ['downloads', 'grossing', 'ratings']) {
      p.ranks[kind] = COUNTRIES.map((cc) => ({ country: cc, points: p.ranks[kind][cc] ?? [] }));
    }
  }
  return pages;
}

// Scrie fiecare fisier prin `emit(key, buffer)`. Intoarce marimile, pentru jurnal.
export function buildExport(db, emit, { log = console.log, cloud = null } = {}) {
  const views = makeViews(db);
  const gz = (obj) => gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 });
  const sizes = { list: 0, term: 0, app: 0, other: 0, files: 0 };
  const put = (key, obj) => {
    const buf = gz(obj);
    sizes[key.split('/')[0]] = (sizes[key.split('/')[0]] ?? 0) + buf.length;
    sizes.files++;
    emit(key, buf);
  };

  put('meta', { generatedAt: new Date().toISOString(), countries: COUNTRIES, categories: views.categories(), status: views.status(), cloud });

  let t = Date.now();
  for (const [key, fn] of listVariants()) put(key, fn(views));
  log(`liste: ${Date.now() - t} ms`);

  t = Date.now();
  const terms = db.prepare('SELECT term FROM seen GROUP BY term ORDER BY length(term), term').all().map((r) => r.term);
  put('terms', terms);
  const shards = Array.from({ length: TERM_SHARDS }, () => ({}));
  for (const term of terms) {
    shards[shardOf(term, TERM_SHARDS)][term] = views.termView(term);
  }
  shards.forEach((s, i) => put(`term/${i}`, s));
  log(`cuvinte: ${terms.length} in ${Date.now() - t} ms`);

  t = Date.now();
  const apps = Array.from({ length: APP_SHARDS }, () => ({}));
  for (const [id, p] of appPages(db, views)) apps[shardOf(id, APP_SHARDS)][id] = p;
  apps.forEach((s, i) => put(`app/${i}`, s));
  log(`app-uri: ${apps.reduce((n, s) => n + Object.keys(s).length, 0)} in ${Date.now() - t} ms`);
  return sizes;
}
