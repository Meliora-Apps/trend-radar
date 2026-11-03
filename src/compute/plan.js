// Din baza de calcul (src/local/db.js): planul colectarii de maine si datele pentru fisierele app-urilor de azi.
import { RETAIN } from '../local/db.js';
import { rising } from '../metrics/trends.js';
import { EXPAND_MAX, expansionPrefixes, nicheAppIds } from '../collect/steps.js';
import { STATS_FIELDS } from '../collect/steps.js';

// Seria scorurilor brute (ca la colectare: scoreDay, fara penalizarea combinatiilor rare) pe zilele complete
// pastrate in baza, si indexul cuvintelor (prima/ultima aparitie + ultima clasificare).
export function collectSeries(db, cc) {
  const dates = db.prepare('SELECT date FROM days WHERE country=? AND complete=1 ORDER BY date DESC LIMIT ?')
    .all(cc, RETAIN.scores).map((r) => r.date).reverse();
  const scores = new Map(dates.map((d) => [d, new Map()]));
  if (dates.length) {
    for (const r of db.prepare('SELECT date, term, score FROM scores WHERE country=? AND date>=?').iterate(cc, dates[0])) {
      scores.get(r.date)?.set(r.term, r.score);
    }
  }
  const index = new Map();
  for (const r of db.prepare('SELECT term, first_seen, last_seen FROM seen WHERE country=?').iterate(cc)) {
    index.set(r.term, { firstSeen: r.first_seen, lastSeen: r.last_seen });
  }
  for (const r of db.prepare('SELECT term, category, subgenre, difficulty, top_app_ids, classified_at, niche FROM class WHERE country=?').iterate(cc)) {
    const e = index.get(r.term) ?? {};
    index.set(r.term, {
      ...e, category: r.category, subgenre: r.subgenre, difficulty: r.difficulty, topAppIds: JSON.parse(r.top_app_ids),
      classifiedAt: r.classified_at, niche: r.niche ? JSON.parse(r.niche) : null,
    });
  }
  return { series: { dates, scores }, index };
}

// Planul pentru colectarea urmatoare a tarii (src/collect/worker.js):
//   expand   = inceputurile de extins; nicheIds = app-urile din nisele calde; hot = cuvintele in crestere;
//   terms    = { cuvant: [firstSeen, classifiedAt, niche.weak, niche.tmax] } pentru coada de clasificare.
export function collectPlan(db, cc) {
  const { series, index } = collectSeries(db, cc);
  const terms = {};
  for (const [t, e] of index) terms[t] = [e.firstSeen ?? null, e.classifiedAt ?? null, e.niche?.weak ?? null, e.niche?.tmax ?? null];
  return {
    country: cc,
    basedOn: series.dates.at(-1) ?? null,
    expand: expansionPrefixes(series, index, EXPAND_MAX),
    nicheIds: nicheAppIds(series, index),
    hot: rising(series, 7).map((r) => r.term),
    terms,
  };
}

// Ce stim despre app-uri inainte de ziua `date` (pentru appFiles din steps.js): id-urile descrise, numele
// actuale si cifrele ultimei zile (doar versiunea conteaza: pentru "versiune noua").
export function appState(db, cc, date) {
  const known = new Set(db.prepare('SELECT id FROM app_meta WHERE country=?').all(cc).map((r) => r.id));
  const names = new Map(db.prepare('SELECT id, name FROM app_names WHERE country=?').all(cc).map((r) => [r.id, r.name]));
  const last = db.prepare('SELECT MAX(date) d FROM app_stats WHERE country=? AND date<?').get(cc, date).d;
  const prev = {};
  if (last) {
    for (const r of db.prepare('SELECT id, ratings, ratings_cur, stars, version, updated, price FROM app_stats WHERE country=? AND date=?').iterate(cc, last)) {
      const row = { ratings: r.ratings, ratingsCur: r.ratings_cur, stars: r.stars, version: r.version, updated: r.updated, price: r.price };
      prev[r.id] = STATS_FIELDS.map((f) => row[f]);
    }
  }
  return { known, names, prev };
}
