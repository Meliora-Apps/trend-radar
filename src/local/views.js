// Datele pentru interfata: serie + index din SQLite -> functiile pure din metrics/.
import { COUNTRIES, CHART_TYPES, DOWNLOAD_TYPES } from '../apple/clients.js';
import { genreName, GENRES, MIXED } from '../apple/genres.js';
import { newTerms, rising, falling, topTerms, disappeared, warmup } from '../metrics/trends.js';
import { chartMovers, themes } from '../metrics/themes.js';
import { addDays, diffDays } from '../util/dates.js';
import { competition, opportunity, chance, isFlooding, saturated, marketEstimate, notANiche, dominantBrand, navigational } from '../metrics/niche.js';
import { BIG_RATINGS } from '../metrics/score.js';

export const SERIES_DAYS = 45;

// Randurile app_hist ale unui app (ordonate dupa tara, data) -> punctele graficelor de pe pagina app-ului.
export function histPoints(rows) {
  const out = { downloads: {}, grossing: {}, ratings: {} };
  for (const r of rows) {
    if (r.dl != null) (out.downloads[r.country] ??= []).push({ date: r.date, score: r.dl });
    if (r.gr != null) (out.grossing[r.country] ??= []).push({ date: r.date, score: r.gr });
    if (r.st) (out.ratings[r.country] ??= []).push({ date: r.date, score: r.ratings });
  }
  for (const kind of Object.keys(out)) out[kind] = COUNTRIES.map((cc) => ({ country: cc, points: out[kind][cc] ?? [] }));
  return out;
}
export const MAX_ROWS = 1500;
// Explozie: in ultimele zile primeste de 3+ ori mai multe rating-uri pe zi decat de obicei (si minim 5/zi).
export const BREAKOUT_RATIO = 3;
export const BREAKOUT_MIN = 5;
export const RECENT_DAYS = 3;
export const LIFETIME_MAX_DAYS = 365;

// Cuvintele cu trafic real dovedit: un app mare care are cuvantul in nume, in primele 10 din cautare.
// Ele pastreaza scorul intreg chiar daca apar doar dupa o combinatie rara de litere ("vpn", "nfl").
export function bigTerms(db, cc) {
  const big = new Set();
  for (const r of db.prepare('SELECT term, niche FROM class WHERE country=? AND niche IS NOT NULL').all(cc)) {
    if ((JSON.parse(r.niche).tmax ?? 0) >= BIG_RATINGS) big.add(r.term);
  }
  return big;
}
export const pickScore = (big, term, score, adj) => (big.has(term) || adj == null ? score : adj);

export function loadSeries(db, cc, days = SERIES_DAYS, big = bigTerms(db, cc)) {
  const dates = db.prepare(
    'SELECT date FROM days WHERE country=? AND complete=1 ORDER BY date DESC LIMIT ?',
  ).all(cc, days).map((r) => r.date).reverse();
  const scores = new Map(dates.map((d) => [d, new Map()]));
  if (dates.length) {
    const rows = db.prepare('SELECT date, term, score, score_adj FROM scores WHERE country=? AND date>=?').all(cc, dates[0]);
    for (const r of rows) scores.get(r.date)?.set(r.term, pickScore(big, r.term, r.score, r.score_adj));
  }
  return { dates, scores };
}

export function loadIndex(db, cc) {
  const index = new Map();
  for (const r of db.prepare('SELECT term, first_seen, last_seen FROM seen WHERE country=?').all(cc)) {
    index.set(r.term, { firstSeen: r.first_seen, lastSeen: r.last_seen });
  }
  for (const r of db.prepare('SELECT * FROM class WHERE country=?').all(cc)) {
    const e = index.get(r.term);
    if (e) Object.assign(e, { category: r.category, subgenre: r.subgenre, difficulty: r.difficulty, topAppIds: JSON.parse(r.top_app_ids) });
  }
  return index;
}

// Cache pe tara, invalidat la fiecare import (versiune).
export function makeViews(db) {
  // Cererile SQL pregatite o singura data (fiecare cerere pregatita tine memorie in SQLite pana e stearsa de GC).
  const stmts = new Map();
  const q = (sql) => {
    if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql));
    return stmts.get(sql);
  };
  let version = 0;
  const cache = new Map();
  const ctx = (cc) => {
    const key = `${cc}:${version}`;
    if (!cache.has(key)) {
      const big = bigTerms(db, cc);
      cache.set(key, { big, series: loadSeries(db, cc, SERIES_DAYS, big), index: loadIndex(db, cc) });
    }
    return cache.get(key);
  };
  const bigOf = (cc) => ctx(cc).big;
  // Bucatile pe tara ale listelor: lista "ALL" le refoloseste pe cele ale tarilor (exportul le cere pe toate).
  const memoCache = new Map();
  const memo = (key, fn) => {
    const k = `${key}:${version}`;
    if (!memoCache.has(k)) memoCache.set(k, fn());
    return memoCache.get(k);
  };

  // Ritmul rating-urilor pe app, dintr-o singura citire (ultimele 14 zile de cifre):
  //   perDay = media pe ultimele pana la 7 zile; recent = pe ultimele pana la 3 zile;
  //   prior  = pe zilele dinainte de cele recente (doar daca acopera minim 4 zile).
  const velCache = new Map();
  function velocity(cc) {
    const key = `${cc}:${version}`;
    if (velCache.has(key)) return velCache.get(key);
    const latest = q('SELECT MAX(date) d FROM app_stats WHERE country=?').get(cc).d;
    const map = new Map();
    if (latest) {
      const byId = new Map();
      for (const r of q('SELECT id, date, ratings, stars, price FROM app_stats WHERE country=? AND date>=? ORDER BY date')
        .all(cc, addDays(latest, -14))) {
        if (!byId.has(r.id)) byId.set(r.id, []);
        byId.get(r.id).push(r);
      }
      const rate = (a, b) => { const d = diffDays(b.date, a.date); return d > 0 ? Math.max(0, (b.ratings - a.ratings) / d) : null; };
      const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
      for (const [id, pts] of byId) {
        const now = pts.at(-1);
        if (now.date !== latest) continue; // app iesit din urmarire
        const w7 = pts.find((p) => p.date >= addDays(latest, -7));
        const start = pts.find((p) => p.date >= addDays(latest, -RECENT_DAYS));
        const first = pts[0];
        // Cel mai slab ritm zilnic din zilele recente: o explozie reala tine cel putin 2 zile la rand
        // (un salt de o singura zi poate fi doar o cifra intarziata de la Apple).
        const steps = [];
        for (let i = pts.indexOf(start) + 1; i < pts.length; i++) steps.push(rate(pts[i - 1], pts[i]));
        map.set(id, {
          sustained: steps.length >= 2 ? round(Math.min(...steps)) : null,
          ratings: now.ratings, stars: now.stars, price: now.price,
          perDay: round(rate(w7, now)), recent: round(rate(start, now)),
          prior: diffDays(start.date, first.date) >= 4 ? round(rate(first, start)) : null,
          ratingsThen: start.ratings, recentFrom: start.date,
        });
      }
    }
    const out = { latest, map };
    velCache.set(key, out);
    return out;
  }

  const enrich = (cc, index, r, withApps = false) => {
    const i = index.get(r.term) ?? {};
    return {
      country: cc, ...r,
      firstSeen: r.firstSeen ?? i.firstSeen ?? null,
      category: i.category ?? null,
      categoryName: i.category == null ? 'Neclasificat' : genreName(i.category),
      subgenreName: i.subgenre ? genreName(i.subgenre) : null,
      difficulty: i.difficulty ?? null,
      ...(withApps ? { apps: (i.topAppIds ?? []).slice(0, 3) } : {}),
    };
  };

  const matchCategory = (category) => (r) => {
    if (category === 'all' || category == null || category === '') return true;
    if (category === 'none') return r.category == null;
    return r.category === Number(category);
  };

  // Cuvant nou: "appeared" = aparut in sugestiile de baza (1-2 litere) sau intr-o extindere pe care o mai
  // intrebasem inainte si nu era acolo; "discovered" = gasit la prima intrebare a unei extinderi
  // (nou pentru noi, nu neaparat pentru lume).
  const firstObs = q('SELECT prefix FROM scores WHERE country=? AND date=? AND term=?');
  const askedBefore = q('SELECT 1 FROM queried_first WHERE country=? AND prefix=? AND first_date<?');
  function origin(cc, term, firstSeen) {
    const prefix = firstObs.get(cc, firstSeen, term)?.prefix;
    if (prefix == null || [...prefix].length <= 2) return 'appeared';
    return askedBefore.get(cc, prefix, firstSeen) ? 'appeared' : 'discovered';
  }

  function view({ name, country = 'US', category = 'all', period = 7, origin: only = 'all', limit = MAX_ROWS }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const p = Number(period) || 7;
    let rows = [];
    const meta = {};
    for (const cc of ccs) {
      const { series, index } = ctx(cc);
      meta[cc] = { warmup: warmup(series.dates), latest: series.dates.at(-1) ?? null };
      const list = memo(`view:${cc}:${name}:${p}`, () => {
        let l;
        if (name === 'new') l = newTerms(series, index, p).map((r) => ({ ...r, origin: origin(cc, r.term, r.firstSeen) }));
        else if (name === 'rising') l = rising(series, p >= 30 ? 30 : 7);
        else if (name === 'falling') l = falling(series, p >= 30 ? 30 : 7);
        else if (name === 'gone') l = disappeared(series);
        else l = topTerms(series);
        return l.map((r) => enrich(cc, index, r, name === 'new'));
      });
      rows.push(...(name === 'new' && (only === 'appeared' || only === 'discovered') ? list.filter((r) => r.origin === only) : list));
    }
    rows = rows.filter(matchCategory(category));
    return { total: rows.length, rows: rows.slice(0, limit), meta };
  }

  function chartList(cc, date, type, genreId) {
    return q(
      'SELECT rank, app_id AS id, name, app_genre AS genreId FROM charts WHERE country=? AND date=? AND type=? AND genre_id=? ORDER BY rank',
    ).all(cc, date, type, genreId);
  }

  function themeView({ country = 'US', category = 'all' }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const out = [];
    for (const cc of ccs) out.push(...memo(`themes:${cc}`, () => themesFor(cc)).filter((t) => category === 'all' || Number(category) === t.genreId));
    return out.sort((a, b) => b.themes.length - a.themes.length || b.movers.length - a.movers.length);
  }

  function themesFor(cc) {
    const out = [];
    const dates = q('SELECT DISTINCT date FROM charts WHERE country=? ORDER BY date DESC LIMIT 8')
      .all(cc).map((r) => r.date);
    const latest = dates[0];
    if (!latest) return out;
    const past = dates.slice(1).filter((d) => d >= addDays(latest, -7));
    const weekAgoDate = past.find((d) => d === addDays(latest, -7)) ?? null;
    const genres = q('SELECT DISTINCT genre_id FROM charts WHERE country=? AND date=?')
      .all(cc, latest).map((r) => r.genre_id);
    for (const g of genres) {
      const movers = [];
      for (const type of CHART_TYPES) {
        const today = chartList(cc, latest, type, g);
        // Un top colectat de curand n-are istoric: fara asta, toate app-urile din el ar parea "nou intrate".
        const pastLists = past.map((d) => chartList(cc, d, type, g)).filter((l) => l.length);
        if (!today.length || !pastLists.length) continue;
        const weekAgo = weekAgoDate ? chartList(cc, weekAgoDate, type, g) : null;
        movers.push(...chartMovers(today, pastLists, weekAgo).map((m) => ({ ...m, type })));
      }
      out.push({
        country: cc, genreId: g, genreName: genreName(g), date: latest,
        historyDays: past.length, movers, themes: themes(movers),
      });
    }
    return out;
  }

  function nicheMarket(cc, ids) {
    const vel = velocity(cc).map;
    const rpd = ids.map((id) => vel.get(id)?.perDay).filter((v) => v != null);
    return rpd.length ? { ...marketEstimate(rpd.reduce((n, v) => n + v, 0)), apps: rpd.length } : null;
  }

  // Prima zi cu scoruri pastrate in baza (vezi RETAIN.scores): graficul nu coboara la 0 inainte de ea.
  const scoresFrom = new Map();
  const scoreStart = (cc) => {
    if (!scoresFrom.has(cc)) scoresFrom.set(cc, q('SELECT MIN(date) d FROM scores WHERE country=?').get(cc).d ?? '');
    return scoresFrom.get(cc);
  };
  const historyQ = q(`SELECT d.date, COALESCE(s.score, 0) AS score, s.score_adj FROM days d
    LEFT JOIN scores s ON s.country=d.country AND s.date=d.date AND s.term=?
    WHERE d.country=? AND d.complete=1 AND d.date>=? ORDER BY d.date DESC LIMIT 90`);
  const seenQ = q('SELECT first_seen, last_seen FROM seen WHERE country=? AND term=?');
  const obsQ = q('SELECT date, prefix, position, score, score_adj FROM scores WHERE country=? AND date=? AND term=?');
  const classQ = q('SELECT * FROM class WHERE country=? AND term=?');

  function termView(term) {
    const t = term.trim().toLowerCase();
    const perCountry = COUNTRIES.map((cc) => {
      const big = bigOf(cc);
      const history = historyQ.all(t, cc, scoreStart(cc)).reverse()
        .map((h) => ({ date: h.date, score: pickScore(big, t, h.score, h.score_adj) }));
      const seen = seenQ.get(cc, t);
      // Ultima observatie = cea din ziua last_seen (daca ziua mai e in baza).
      const lastRow = seen ? obsQ.get(cc, seen.last_seen, t) : null;
      const last = lastRow ? { date: lastRow.date, prefix: lastRow.prefix, position: lastRow.position,
        score: pickScore(big, t, lastRow.score, lastRow.score_adj), rare: !big.has(t) && lastRow.score_adj != null && lastRow.score_adj < lastRow.score } : null;
      const cls = classQ.get(cc, t);
      return {
        country: cc, history, last: last ?? null,
        firstSeen: seen?.first_seen ?? null, lastSeen: seen?.last_seen ?? null,
        category: cls ? genreName(cls.category) : null,
        subgenre: cls?.subgenre ? genreName(cls.subgenre) : null,
        difficulty: cls?.difficulty ?? null,
        topAppIds: cls ? JSON.parse(cls.top_app_ids) : [],
        niche: cls?.niche ? JSON.parse(cls.niche) : null,
        competition: cls?.niche ? competition(JSON.parse(cls.niche)) : null,
        chance: cls?.niche ? chance(JSON.parse(cls.niche)) : null,
        market: cls ? nicheMarket(cc, JSON.parse(cls.top_app_ids)) : null,
      };
    });
    return { term: t, countries: perCountry, saturated: saturated(t) };
  }

  // Cuvintele pe care app-ul apare in primele 10 (din clasificarile noastre), pe tari.
  function appKeywords(appId) {
    const id = String(Number(appId));
    const out = [];
    for (const cc of COUNTRIES) {
      const latest = q('SELECT MAX(date) d FROM days WHERE country=? AND complete=1').get(cc).d;
      const big = bigOf(cc);
      const rows = q(`SELECT c.term, c.top_app_ids, c.classified_at, c.category, s.score, s.score_adj
        FROM class c LEFT JOIN scores s ON s.country=c.country AND s.term=c.term AND s.date=?
        WHERE c.country=? AND instr(',' || substr(c.top_app_ids, 2, length(c.top_app_ids) - 2) || ',', ',' || ? || ',') > 0`)
        .all(latest, cc, id);
      for (const r of rows) {
        const position = JSON.parse(r.top_app_ids).map(String).indexOf(id) + 1;
        if (position > 0) {
          out.push({ country: cc, term: r.term, position, score: r.score == null ? 0 : pickScore(big, r.term, r.score, r.score_adj), classifiedAt: r.classified_at, categoryName: genreName(r.category) });
        }
      }
    }
    return out.sort((a, b) => b.score - a.score || a.position - b.position);
  }

  // Rating-urile unui app: cate are acum si cate a primit pe zi (fata de cea mai veche zi din ultimele 7).
  const statsSince = q('SELECT date, ratings, stars, price FROM app_stats WHERE country=? AND id=? AND date>=? AND date<=? ORDER BY date');
  function ratingTrend(cc, id, latest) {
    return memo(`trend:${cc}:${id}:${latest}`, () => ratingTrendOf(cc, id, latest));
  }
  function ratingTrendOf(cc, id, latest) {
    const pts = statsSince.all(cc, id, addDays(latest, -7), latest);
    if (!pts.length) return { ratings: null, perDay: null, stars: null, price: null };
    const now = pts.at(-1);
    const then = pts[0];
    const days = diffDays(now.date, then.date);
    return {
      ratings: now.ratings, stars: now.stars, price: now.price,
      perDay: days > 0 ? Math.round(((now.ratings - then.ratings) / days) * 10) / 10 : null,
    };
  }

  // Ziua din care urmarim topurile unei tari: "ajunsa in top in N zile" are sens doar pentru app-urile lansate dupa.
  const trackStart = (cc) => q('SELECT MIN(first_date) d FROM chart_first WHERE country=?').get(cc).d;
  const typeOk = (type) => (t) => (type === 'free' ? t === 'topfreeapplications'
    : type === 'paid' ? t === 'toppaidapplications'
      : type === 'grossing' ? t === 'topgrossingapplications' : true);

  // Bucata unei tari din newApps: app-urile din topurile de azi lansate in ultimele `days` zile.
  function chartAppsFor(cc, type, days) {
    const out = [];
    const latest = q('SELECT MAX(date) d FROM charts WHERE country=?').get(cc).d;
    if (!latest) return { latest, list: out };
    const since = addDays(latest, -days);
    const weekAgo = addDays(latest, -7);
    const start = trackStart(cc);
    const rows = q(`SELECT c.app_id id, c.type, c.genre_id, c.rank, c.name, m.genre_id app_genre,
        m.release_date, m.seller
      FROM charts c JOIN app_meta m ON m.country=c.country AND m.id=c.app_id
      WHERE c.country=? AND c.date=? AND m.release_date>=?`).all(cc, latest, since);
    const rankThen = q('SELECT rank FROM charts WHERE country=? AND date=? AND type=? AND genre_id=? AND app_id=?');
    const chartsThen = new Set(q('SELECT DISTINCT type, genre_id FROM charts WHERE country=? AND date=?').all(cc, weekAgo).map((r) => `${r.type}/${r.genre_id}`));
    const firstIn = q('SELECT first_date d FROM chart_first WHERE country=? AND app_id=?');
    const best = new Map();
    const gross = new Map(); // id -> cel mai bun loc in topul incasarilor
    for (const r of rows) {
      if (r.type === 'topgrossingapplications' && (!gross.has(r.id) || r.rank < gross.get(r.id).rank)) gross.set(r.id, r);
      if (!typeOk(type)(r.type)) continue;
      const hist = chartsThen.has(`${r.type}/${r.genre_id}`);
      const dl = DOWNLOAD_TYPES.includes(r.type);
      const b = best.get(r.id);
      if (!b) best.set(r.id, { ...r, dl, charts: 1, hist: hist ? r : null });
      else {
        b.charts++;
        // Cel mai bun loc se ia din topurile de descarcari; incasarile doar daca nu e in niciunul.
        if ((dl && !b.dl) || (dl === b.dl && r.rank < b.rank)) Object.assign(b, { type: r.type, genre_id: r.genre_id, rank: r.rank, dl });
        if (hist && (!b.hist || r.rank < b.hist.rank)) b.hist = r;
      }
    }
    for (const b of best.values()) {
      // Urcarea se masoara in cel mai bun top care exista si acum 7 zile (topurile noi n-au inca istoric).
      const h = b.hist;
      const then = h ? rankThen.get(cc, weekAgo, h.type, h.genre_id, b.id)?.rank ?? null : null;
      const since0 = firstIn.get(cc, b.id).d;
      const g = gross.get(b.id);
      const entry = {
        country: cc, bestRank: b.rank, type: b.type, chartGenre: b.genre_id, charts: b.charts,
        climb: then == null ? null : then - h.rank, newInChart: !!h && then == null,
        climbChart: h && (h.type !== b.type || h.genre_id !== b.genre_id) ? { genre: h.genre_id, type: h.type, rank: h.rank } : null,
        inTopSince: since0,
        daysToTop: b.release_date && b.release_date >= start ? Math.max(0, diffDays(since0, b.release_date)) : null,
        gross: g ? { rank: g.rank, genre: g.genre_id } : null,
        ...ratingTrend(cc, b.id, latest),
      };
      out.push({ b, entry });
    }
    return { latest, list: out };
  }

  // Aplicatii noi in topuri: lansate in ultimele `launched` zile si prezente in topurile de azi.
  // Pentru fiecare: cel mai bun loc (si in ce top), urcarea fata de acum 7 zile in ACELASI top, in cate tari,
  // locul in topul incasarilor ("face bani"), rating-urile pe zi (semnul descarcarilor).
  // source='feed': lansarile noi ale Apple care NU sunt (inca) in topuri, cele cu rating-uri rapide primele.
  function newApps({ country = 'US', category = 'all', type = 'all', launched = 90, source = 'charts', limit = MAX_ROWS }) {
    if (source === 'feed') return feedApps({ country, category, launched, limit });
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const days = Number(launched) || 90;
    const byId = new Map();
    for (const cc of ccs) {
      // Calculat o data pe tara si top, pentru cea mai lunga perioada; perioadele scurte sunt doar un filtru.
      const span = Math.max(days, 365);
      const part = memo(`apps:${cc}:${type}:${span}`, () => chartAppsFor(cc, type, span));
      for (const { b, entry } of part.list) {
        if (b.release_date < addDays(part.latest, -days)) continue;
        const cur = byId.get(b.id);
        if (!cur) {
          byId.set(b.id, { id: b.id, name: b.name, seller: b.seller, genreId: b.app_genre, releaseDate: b.release_date, best: entry, all: [entry] });
        } else {
          cur.all.push(entry);
          if (entry.bestRank < cur.best.bestRank) cur.best = entry;
        }
      }
    }
    let out = [...byId.values()].map((a) => {
      const g = a.all.filter((e) => e.gross).sort((x, y) => x.gross.rank - y.gross.rank)[0];
      const perDays = a.all.map((e) => e.perDay).filter((v) => v != null);
      const dtt = a.all.map((e) => e.daysToTop).filter((v) => v != null);
      return {
        id: a.id, name: a.name, seller: a.seller, releaseDate: a.releaseDate,
        genreId: a.genreId, categoryName: genreName(a.genreId),
        country: a.best.country, countries: a.all.map((e) => e.country), countryCount: a.all.length,
        bestRank: a.best.bestRank, type: a.best.type, bestChartName: genreName(a.best.chartGenre),
        climb: a.best.climb, newInChart: a.best.newInChart,
        climbChartName: a.best.climbChart ? `${genreName(a.best.climbChart.genre)} #${a.best.climbChart.rank}` : null,
        charts: a.best.charts, inTopSince: a.best.inTopSince,
        daysToTop: dtt.length ? Math.min(...dtt) : null,
        grossRank: g ? g.gross.rank : null, grossChartName: g ? genreName(g.gross.genre) : null, grossCountry: g?.country ?? null,
        grossCountries: a.all.filter((e) => e.gross).length,
        ratings: a.all.reduce((n, e) => n + (e.ratings ?? 0), 0),
        ratingsPerDay: perDays.length ? Math.round(perDays.reduce((n, v) => n + v, 0) * 10) / 10 : null,
        stars: a.best.stars, price: a.best.price,
      };
    });
    if (category !== 'all' && category != null && category !== '') out = out.filter((a) => a.genreId === Number(category));
    out.sort((a, b) => b.countryCount - a.countryCount || a.bestRank - b.bestRank);
    return { total: out.length, rows: out.slice(0, limit) };
  }

  // Lansarile noi ale Apple (din prima zi) care inca nu sunt in topurile urmarite.
  function feedApps({ country = 'US', category = 'all', launched = 90, limit = MAX_ROWS }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const days = Number(launched) || 90;
    const byId = new Map();
    for (const cc of ccs) {
      const latest = q('SELECT MAX(date) d FROM days WHERE country=?').get(cc).d;
      if (!latest) continue;
      const inCharts = new Set(q('SELECT DISTINCT app_id FROM charts WHERE country=? AND date=?').all(cc, latest).map((r) => r.app_id));
      const rows = q(`SELECT f.app_id id, MIN(f.date) first_feed, MAX(f.date) last_feed, MAX(f.type) type,
          m.name, m.genre_id, m.release_date, m.seller
        FROM new_feed f JOIN app_meta m ON m.country=f.country AND m.id=f.app_id
        WHERE f.country=? AND f.date>=? GROUP BY f.app_id`).all(cc, addDays(latest, -days));
      for (const r of rows) {
        if (inCharts.has(r.id)) continue;
        const entry = { country: cc, firstInFeed: r.first_feed, type: r.type, ...ratingTrend(cc, r.id, latest) };
        const cur = byId.get(r.id);
        if (!cur) byId.set(r.id, { r, all: [entry] });
        else cur.all.push(entry);
      }
    }
    let out = [...byId.values()].map(({ r, all }) => {
      const perDays = all.map((e) => e.perDay).filter((v) => v != null);
      const best = [...all].sort((x, y) => (y.perDay ?? -1) - (x.perDay ?? -1) || (y.ratings ?? 0) - (x.ratings ?? 0))[0];
      return {
        id: r.id, name: r.name, seller: r.seller, releaseDate: r.release_date, genreId: r.genre_id, categoryName: genreName(r.genre_id),
        country: best.country, countries: all.map((e) => e.country), countryCount: all.length,
        type: r.type === 'newpaidapplications' ? 'toppaidapplications' : 'topfreeapplications',
        firstInFeed: all.map((e) => e.firstInFeed).sort()[0],
        ratings: all.reduce((n, e) => n + (e.ratings ?? 0), 0),
        ratingsPerDay: perDays.length ? Math.round(perDays.reduce((n, v) => n + v, 0) * 10) / 10 : null,
        stars: best.stars, price: best.price,
      };
    });
    if (category !== 'all' && category != null && category !== '') out = out.filter((a) => a.genreId === Number(category));
    out.sort((a, b) => (b.ratingsPerDay ?? -1) - (a.ratingsPerDay ?? -1) || b.ratings - a.ratings || (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    return { total: out.length, rows: out.slice(0, limit) };
  }

  // Pentru graficele de pe pagina aplicatiei: locul in topurile de descarcari, in topul incasarilor si rating-urile, pe zile.
  // (din app_hist: zilnic in ultimele RETAIN.histDaily zile, apoi o zi pe saptamana)
  function appRanks(appId) {
    const rows = q('SELECT country, date, dl, gr, st, ratings FROM app_hist WHERE id=? ORDER BY country, date').all(Number(appId));
    return histPoints(rows);
  }

  // Nise calde: cuvintele noi si cele in crestere, cu concurenta din primele 10 app-uri si cine face bani acolo.
  // Implicit ascundem ce nu e o nisa reala (vezi notANiche); all = true le arata si pe ele, marcate.
  function nicheView({ country = 'US', category = 'all', period = 14, brands = false, all = false, limit = MAX_ROWS }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const p = Number(period) || 14;
    const rows = [];
    for (const cc of ccs) rows.push(...memo(`niches:${cc}:${p}`, () => nichesFor(cc, p)));
    const inCat = rows.filter(matchCategory(category)).filter((r) => brands || !r.brand).map((r) => ({ ...r }));
    const hidden = { few: 0, money: 0, lang: 0, brand: 0, code: 0, mixed: 0 };
    for (const r of inCat) {
      // Rezultate din categorii fara legatura (sub 4 din 10 in aceeasi): Apple nu stie ce e cuvantul (de obicei un nume).
      if (!r.notNiche && r.category === MIXED) r.notNiche = 'mixed';
      if (r.notNiche) hidden[r.notNiche]++;
    }
    const out = inCat.filter((r) => all || !r.notNiche)
      .sort((a, b) => (!!a.notNiche - !!b.notNiche) || (b.opportunity ?? -1) - (a.opportunity ?? -1) || b.score - a.score);
    return { total: out.length, rows: out.slice(0, limit), measured: out.filter((r) => r.competition != null).length, hidden };
  }

  function nichesFor(cc, p) {
    const rows = [];
    const { series, index } = ctx(cc);
    const latestChart = q('SELECT MAX(date) d FROM charts WHERE country=?').get(cc).d;
    const grossing = new Set(q("SELECT DISTINCT app_id FROM charts WHERE country=? AND date=? AND type='topgrossingapplications'")
      .all(cc, latestChart).map((r) => r.app_id));
    const fresh = q('SELECT release_date FROM app_meta WHERE country=? AND id=?');
    const nicheOf = q('SELECT niche FROM class WHERE country=? AND term=?');
    const cand = new Map();
    for (const r of newTerms(series, index, p)) cand.set(r.term, { ...r, isNew: true, delta: null });
    for (const r of rising(series, 7)) if (!cand.has(r.term)) cand.set(r.term, { ...r, isNew: false });
    const recent = series.dates.length ? addDays(series.dates.at(-1), -180) : null;
    const vel = velocity(cc).map;
    const nameOf = q('SELECT name, seller FROM app_meta WHERE country=? AND id=?');
    const big = bigOf(cc);
    for (const r of cand.values()) {
      const i = index.get(r.term) ?? {};
      const nRow = nicheOf.get(cc, r.term)?.niche;
      const niche = nRow ? JSON.parse(nRow) : null;
      const comp = competition(niche);
      const top = i.topAppIds ?? [];
      const ch = chance(niche);
      const sat = saturated(r.term);
      const rpd = top.map((id) => vel.get(id)?.perDay).filter((v) => v != null);
      const market = rpd.length ? marketEstimate(rpd.reduce((n, v) => n + v, 0)) : null;
      const brand = !!niche?.brand || dominantBrand(r.term, top.filter((id) => vel.get(id)?.perDay != null)
        .map((id) => ({ perDay: vel.get(id).perDay, name: nameOf.get(cc, id)?.name })));
      const moneyApps = top.filter((id) => grossing.has(id));
      const newApps = top.filter((id) => { const d = fresh.get(cc, id)?.release_date; return d && recent && d >= recent; });
      rows.push(enrich(cc, index, {
        term: r.term, score: r.score, delta: r.delta ?? null, isNew: r.isNew, firstSeen: r.firstSeen ?? null,
        preliminary: r.preliminary ?? false,
        competition: comp, brand,
        opportunity: opportunity({ score: r.score, delta: r.delta, isNew: r.isNew, comp, brand, chance: ch, sat }),
        chance: ch?.value ?? null, chanceApprox: !!ch?.approx, flooding: isFlooding(niche), sat,
        market, marketApps: rpd.length, notNiche: notANiche({ term: r.term, niche, market, proven: big.has(r.term),
          navig: navigational(r.term, top.slice(0, 3).map((id) => nameOf.get(cc, id) ?? {})) }),
        niche, moneyApps: moneyApps.length, freshApps: niche ? niche.fresh : newApps.length,
        apps: top.slice(0, 3), moneyIds: moneyApps.slice(0, 3),
      }));
    }
    return rows;
  }

  const metaOf = (cc) => new Map(q('SELECT id, name, genre_id, release_date, seller FROM app_meta WHERE country=?').all(cc).map((m) => [m.id, m]));
  // Cel mai bun loc de azi in topurile de descarcari si in topul incasarilor, pe app.
  function todayRanks(cc) {
    const latest = q('SELECT MAX(date) d FROM charts WHERE country=?').get(cc).d;
    const dl = new Map(), gross = new Map();
    for (const r of q('SELECT app_id id, type, genre_id, rank FROM charts WHERE country=? AND date=?').all(cc, latest)) {
      const m = r.type === 'topgrossingapplications' ? gross : dl;
      if (!m.has(r.id) || r.rank < m.get(r.id).rank) m.set(r.id, r);
    }
    return { dl, gross };
  }
  const byCategory = (category) => (a) => category === 'all' || category == null || category === '' || a.genreId === Number(category);

  function breakoutsFor(cc) {
    const list = [];
    let measured = 0;
    const { latest, map } = velocity(cc);
    if (!latest) return { list, measured };
    const meta = metaOf(cc);
    const { dl, gross } = todayRanks(cc);
    for (const [id, v] of map) {
      if (v.sustained == null) continue;
      measured++;
      if (v.recent < BREAKOUT_MIN || v.sustained < BREAKOUT_MIN) continue;
      const m = meta.get(id);
      const age = m?.release_date ? diffDays(v.recentFrom, m.release_date) : null;
      // Media de la lansare e un reper bun doar pentru app-urile din ultimul an (cele vechi primeau mult mai
      // putine rating-uri inainte ca Apple sa ceara rating in aplicatie); pentru ele asteptam zilele dinainte.
      const baseline = v.prior ?? (age != null && age > 0 && age <= LIFETIME_MAX_DAYS ? v.ratingsThen / Math.max(30, age) : null);
      if (baseline == null) continue;
      const ratio = v.sustained / Math.max(baseline, 0.5);
      if (ratio < BREAKOUT_RATIO) continue;
      const d = dl.get(id), g = gross.get(id);
      const entry = {
        country: cc, recent: v.recent, baseline: Math.round(baseline * 10) / 10, baselineKind: v.prior != null ? 'prior' : 'lifetime',
        ratio: Math.round(ratio * 10) / 10, ratings: v.ratings, stars: v.stars,
        bestRank: d?.rank ?? null, bestChartName: d ? genreName(d.genre_id) : null, type: d?.type ?? null,
        grossRank: g?.rank ?? null, grossChartName: g ? genreName(g.genre_id) : null,
      };
      list.push({ id, m, entry });
    }
    return { list, measured };
  }

  // Explozii: app-urile (din topuri, lansari noi si nisele calde) care in ultimele zile primesc mult mai multe
  // rating-uri pe zi decat de obicei. "De obicei" = zilele dinainte (cand avem minim 4) sau media de la lansare.
  // Raportul se ia din cea mai slaba zi recenta (minim 2 zile la rand), ca un salt de o zi sa nu para explozie.
  function breakoutView({ country = 'US', category = 'all', limit = MAX_ROWS }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const byId = new Map();
    let measured = 0;
    for (const cc of ccs) {
      const part = memo(`breakouts:${cc}`, () => breakoutsFor(cc));
      measured += part.measured;
      for (const { id, m, entry } of part.list) {
        const cur = byId.get(id);
        if (!cur) byId.set(id, { id, name: m?.name ?? String(id), seller: m?.seller ?? '', genreId: m?.genre_id ?? null, releaseDate: m?.release_date ?? null, all: [entry] });
        else cur.all.push(entry);
      }
    }
    const out = [...byId.values()].map((a) => {

      const best = [...a.all].sort((x, y) => y.ratio - x.ratio)[0];
      const recent = Math.round(a.all.reduce((n, e) => n + e.recent, 0) * 10) / 10;
      return {
        id: a.id, name: a.name, seller: a.seller, genreId: a.genreId, categoryName: genreName(a.genreId), releaseDate: a.releaseDate,
        ...best, recent, countries: a.all.map((e) => e.country), countryCount: a.all.length,
        estimate: marketEstimate(recent),
      };
    }).filter(byCategory(category))
      .sort((x, y) => y.ratio * Math.log10(y.recent + 1) - x.ratio * Math.log10(x.recent + 1));
    return { total: out.length, rows: out.slice(0, limit), measured };
  }

  // Ce schimba aplicatiile: nume (test de cuvinte cheie), versiuni noi (cu noutatile la cei care fac bani), pret.
  // who='money' = doar cele din topul incasarilor de azi.
  function changesView({ country = 'US', category = 'all', period = 7, who = 'money', limit = MAX_ROWS }) {
    const ccs = country === 'ALL' ? COUNTRIES : [country];
    const p = Number(period) || 7;
    const out = [];
    for (const cc of ccs) out.push(...memo(`changes:${cc}:${p}`, () => changesFor(cc, p)));
    const rows = out.filter(byCategory(category)).filter((r) => who !== 'money' || r.grossRank != null)
      .sort((a, b) => b.date.localeCompare(a.date) || (a.grossRank ?? 999) - (b.grossRank ?? 999)
        || COUNTRIES.indexOf(a.country) - COUNTRIES.indexOf(b.country) || a.id - b.id || a.field.localeCompare(b.field));
    return { total: rows.length, rows: rows.slice(0, limit) };
  }

  function changesFor(cc, p) {
    const out = [];
    const dates = q('SELECT DISTINCT date FROM app_stats WHERE country=? ORDER BY date DESC LIMIT ?').all(cc, p + 1).map((r) => r.date).reverse();
    if (dates.length < 2) return out;
    const since = dates[1];
    const meta = metaOf(cc);
    const { dl, gross } = todayRanks(cc);
    const push = (id, date, field, from, to, notes = null) => {
      const m = meta.get(id);
      const g = gross.get(id), d = dl.get(id);
      out.push({
        country: cc, date, id, field, from, to, notes,
        name: field === 'name' ? to : m?.name ?? String(id), seller: m?.seller ?? '', genreId: m?.genre_id ?? null, categoryName: genreName(m?.genre_id),
        grossRank: g?.rank ?? null, grossChartName: g ? genreName(g.genre_id) : null,
        bestRank: d?.rank ?? null, bestChartName: d ? genreName(d.genre_id) : null,
      });
    };
    for (const c of q('SELECT * FROM app_changes WHERE country=? AND date>=?').all(cc, since)) push(c.id, c.date, c.field, c.from_v, c.to_v, c.notes);
    const price = q(`SELECT a.id, a.price now, b.price was FROM app_stats a JOIN app_stats b ON b.country=a.country AND b.id=a.id AND b.date=?
      WHERE a.country=? AND a.date=? AND a.price IS NOT b.price`);
    for (let i = 1; i < dates.length; i++) {
      for (const r of price.all(dates[i - 1], cc, dates[i])) push(r.id, dates[i], 'price', r.was, r.now);
    }
    return out;
  }

  // Pentru pagina aplicatiei: estimarea descarcarilor/banilor pe tari si istoricul schimbarilor.
  function appExtra(appId) {
    const id = Number(appId);
    const estimates = [];
    for (const cc of COUNTRIES) {
      const v = velocity(cc).map.get(id);
      if (v?.perDay != null) estimates.push({ country: cc, perDay: v.perDay, ...marketEstimate(v.perDay) });
    }
    const changes = q('SELECT country, date, field, from_v "from", to_v "to", notes FROM app_changes WHERE id=? ORDER BY date DESC LIMIT 60').all(id);
    return { estimates, changes };
  }

  // Primele app-uri dintr-o nisa (din clasificare), pentru recenziile nisei.
  function termApps(term, cc) {
    const r = q('SELECT top_app_ids FROM class WHERE country=? AND term=?').get(cc, term.trim().toLowerCase());
    return r ? JSON.parse(r.top_app_ids) : null;
  }

  function suggestTerms(text) {
    return q('SELECT DISTINCT term FROM seen WHERE term LIKE ? ORDER BY length(term) LIMIT 15')
      .all(`${text.trim().toLowerCase()}%`).map((r) => r.term);
  }

  function categories() {
    const used = new Set(q('SELECT DISTINCT category FROM class').all().map((r) => r.category));
    return [
      ...Object.keys(GENRES).map(Number).filter((g) => used.has(g)).map((g) => ({ id: g, name: genreName(g) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ...(used.has(0) ? [{ id: 0, name: 'Mixt' }] : []),
    ];
  }

  function status() {
    const countries = {};
    for (const cc of COUNTRIES) {
      const s = loadSeries(db, cc, 1000);
      const all = q('SELECT COUNT(*) n FROM days WHERE country=?').get(cc).n;
      const incomplete = q('SELECT date FROM days WHERE country=? AND complete=0 ORDER BY date DESC LIMIT 10').all(cc).map((r) => r.date);
      const terms = q('SELECT COUNT(*) n FROM seen WHERE country=?').get(cc).n;
      const classified = q('SELECT COUNT(*) n FROM class WHERE country=?').get(cc).n;
      countries[cc] = { warmup: warmup(s.dates), latest: s.dates.at(-1) ?? null, days: all, incomplete, terms, classified };
    }
    const problems = q('SELECT * FROM problems').all();
    return { countries, problems };
  }

  return {
    view, themeView, termView, suggestTerms, appKeywords, newApps, appRanks, nicheView, breakoutView, changesView, appExtra, termApps,
    categories, status, bigOf, velocity,
    invalidate: () => { version++; cache.clear(); velCache.clear(); memoCache.clear(); },
    forget: () => memoCache.clear(), // dupa liste: bucatile pe tara nu mai trebuie
  };
}
