// Colectarea zilnica pentru O tara: sugestii -> extindere long-tail -> topuri -> clasificare.
import { prefixesFor } from './prefixes.js';
import { CHART_TYPES, NEW_FEEDS } from '../apple/clients.js';
import { CHART_GENRES } from '../apple/genres.js';
import { scoreDay, scoreDayAdjusted, difficulty, categorize } from '../metrics/score.js';
import { buildFromDays, applyClassifications } from '../metrics/build.js';
import { newTerms, rising } from '../metrics/trends.js';
import { nicheStats } from '../metrics/niche.js';
import {
  dayPath, classifyPath, writeJsonGz, readCountryDays, readCountryClassifications,
} from '../data/files.js';
import { addDays } from '../util/dates.js';
import { collectAppMeta } from './app-meta.js';

const NEW_PRIORITY_DAYS = 7;
export const NICHE_DAYS = 14;
export const NICHE_APPS_MAX = 15000; // ~150 cereri lookup (100 id-uri/cerere), ~10 min
export const RECLASSIFY_DAYS = 30;
export const MAX_FAILURE_RATE = 0.1;

// Ce extindem azi: cuvintele noi de ieri + cele in crestere pe 7 zile, cele cu scor mare primele.
export function expansionPrefixes(series, index, max) {
  const latest = series.dates.at(-1);
  if (!latest) return [];
  const scoreOf = (t) => series.scores.get(latest).get(t) ?? 0;
  const terms = new Set([...newTerms(series, index, 1), ...rising(series, 7)].map((r) => r.term));
  const prefixes = [];
  for (const t of [...terms].sort((a, b) => scoreOf(b) - scoreOf(a))) {
    const p = `${t.split(' ')[0]} `;
    if (!prefixes.includes(p)) prefixes.push(p);
    if (prefixes.length >= max) break;
  }
  return prefixes;
}

// Cuvintele vazute azi, fara clasificare sau clasificate acum >30 zile; scor mare primele.
// Cuvintele aparute recent (sau azi, inca neindexate) primele: pentru ele vrem app-urile cat mai repede.
// Apoi cele in crestere (`hot`) clasificate inainte de scorul de nisa: le refacem ca sa aiba concurenta.
// (si cele masurate inainte de "sansa ta": fara weak/fresh90/stale). La fel cele vazute doar dupa combinatii rare de litere (`rare`): app-ul cel mai mare din top decide
// daca isi pastreaza scorul intreg in interfata.
export function classificationQueue(index, todayScores, date, hot = new Set(), rare = new Set()) {
  const stale = addDays(date, -RECLASSIFY_DAYS);
  const recent = addDays(date, -NEW_PRIORITY_DAYS);
  const isNew = (t) => { const fs = index.get(t)?.firstSeen; return !fs || fs >= recent; };
  const noNiche = (t) => {
    const e = index.get(t);
    return (hot.has(t) && e?.niche?.weak == null) || (rare.has(t) && e?.niche?.tmax == null);
  };
  const rank = (t) => (isNew(t) ? 2 : noNiche(t) ? 1 : 0);
  return [...todayScores.keys()]
    .filter((t) => { const c = index.get(t)?.classifiedAt; return !c || c <= stale || noNiche(t); })
    .sort((a, b) => rank(b) - rank(a) || todayScores.get(b) - todayScores.get(a));
}

// App-urile din primele 10 ale nisellor calde (cuvinte noi pe 14 zile + in crestere), cele cu scor mare primele:
// le urmarim rating-urile zilnic ca sa estimam cati bani sunt in nisa.
export function nicheAppIds(series, index, max = NICHE_APPS_MAX) {
  const latest = series.dates.at(-1);
  if (!latest) return [];
  const scoreOf = (t) => series.scores.get(latest).get(t) ?? 0;
  const terms = [...new Set([...newTerms(series, index, NICHE_DAYS), ...rising(series, 7)].map((r) => r.term))]
    .sort((a, b) => scoreOf(b) - scoreOf(a));
  const ids = new Set();
  for (const t of terms) {
    for (const id of index.get(t)?.topAppIds ?? []) {
      if (ids.size >= max) return [...ids];
      ids.add(id);
    }
  }
  return [...ids];
}

export async function runCountry({
  country, date, dataDir, apple,
  budget = {}, smoke = false, log = console.log, clock = Date.now,
}) {
  const {
    prefixes = prefixesFor(country),
    expandMax = 300,
    chartGenres = CHART_GENRES,
    classifyMs = 3 * 3600_000,
    classifyMax = Infinity,
    appMetaMax = Infinity,
  } = budget;
  const { counter } = apple;
  let aborted = false;
  const stop = () => {
    if (!aborted && counter.tooManyFailures(50, MAX_FAILURE_RATE)) {
      aborted = true;
      log(`[${country}] prea multe erori (${counter.stats.failures}/${counter.stats.requests}) -> opresc colectarea`);
    }
    return aborted;
  };

  // Istoricul dinainte de azi (din depozit).
  const { series, index } = buildFromDays(readCountryDays(dataDir, country, { before: date }));
  applyClassifications(index, readCountryClassifications(dataDir, country, { before: date }));

  // 1. Sugestii
  const suggest = [];
  const ask = async (prefix, kind) => {
    try {
      suggest.push({ prefix, kind, terms: await apple.suggest(prefix, country) });
    } catch (err) {
      log(`[${country}] hints "${prefix}" esuat: ${err.message}`);
    }
  };
  log(`[${country}] sugestii: ${prefixes.length} inceputuri`);
  for (const p of prefixes) { if (stop()) break; await ask(p, 'base'); }

  // 2. Extindere long-tail
  const expand = expansionPrefixes(series, index, expandMax).filter((p) => !prefixes.includes(p));
  log(`[${country}] extindere: ${expand.length} inceputuri`);
  for (const p of expand) { if (stop()) break; await ask(p, 'expand'); }

  // Ziua e completa daca am cules cuvintele (pasii 1-2). Erorile de mai tarziu (ex. Apple blocheaza cautarea
  // la clasificare) nu strica cuvintele zilei: clasificarea ramasa se reia maine.
  const keywordsOk = !aborted && counter.failureRate() <= MAX_FAILURE_RATE && suggest.length > 0;

  // 3. Topuri
  const charts = [];
  log(`[${country}] topuri: ${chartGenres.length} genuri x ${CHART_TYPES.length}`);
  for (const genreId of chartGenres) {
    for (const type of CHART_TYPES) {
      if (stop()) break;
      try {
        charts.push({ type, genreId, apps: await apple.chart(country, type, genreId) });
      } catch (err) {
        log(`[${country}] rss ${type}/${genreId} esuat: ${err.message}`);
      }
    }
  }

  // 3b. Lansarile noi ale Apple (cele mai devreme semne: app-uri din prima zi)
  const newFeed = [];
  for (const type of NEW_FEEDS) {
    if (stop()) break;
    try {
      newFeed.push({ type, apps: await apple.newFeed(country, type) });
    } catch (err) {
      log(`[${country}] rss ${type} esuat: ${err.message}`);
    }
  }

  // 3c. Lookup: data lansarii (app-uri noi) + rating-urile zilei (toate) pentru "Aplicatii noi",
  //     plus app-urile din nisele calde (banii din nisa).
  const extraIds = [...newFeed.flatMap((f) => f.apps.map((a) => a.id)), ...nicheAppIds(series, index)];
  const appMeta = await collectAppMeta({
    country, date, dataDir, apple, charts, extraIds, log, stop, max: appMetaMax,
  });

  // 4. Clasificare pe categorii (in limita de timp; restul ramane pe maine)
  const todayScores = scoreDay(suggest);
  const hot = new Set(rising(series, 7).map((r) => r.term));
  const adjusted = scoreDayAdjusted(suggest);
  const rare = new Set([...todayScores.keys()].filter((t) => adjusted.get(t) < todayScores.get(t)));
  const queue = classificationQueue(index, todayScores, date, hot, rare);
  const classified = {};
  const deadline = clock() + classifyMs;
  log(`[${country}] clasificare: ${queue.length} in coada`);
  for (const term of queue) {
    if (stop() || clock() > deadline || Object.keys(classified).length >= classifyMax) break;
    try {
      const apps = await apple.topApps(term, country);
      classified[term] = {
        ...categorize(apps),
        difficulty: difficulty(apps.map((a) => a.ratings)),
        topAppIds: apps.map((a) => a.id),
        niche: nicheStats(apps, term, date),
        classifiedAt: date,
      };
    } catch (err) {
      log(`[${country}] search "${term}" esuat: ${err.message}`);
    }
  }

  const { requests, failures } = counter.stats;
  // O rulare de proba acopera putine inceputuri: nu conteaza ca zi completa (ar strica trendurile).
  const complete = !smoke && keywordsOk;
  writeJsonGz(dayPath(dataDir, date, country), {
    date, country, complete, smoke, requests, errors: failures, suggest, charts, newFeed,
  });
  // Scris mereu (si gol), ca artefactul din GitHub sa pastreze structura data/days + data/classify.
  writeJsonGz(classifyPath(dataDir, date, country), classified);

  const summary = {
    country, date, complete, requests, errors: failures,
    terms: todayScores.size, expanded: expand.length, charts: charts.length, newFeed: newFeed.reduce((n, f) => n + f.apps.length, 0),
    appMeta, classified: Object.keys(classified).length, queueLeft: queue.length - Object.keys(classified).length,
  };
  log(`[${country}] gata: ${JSON.stringify(summary)}`);
  return summary;
}
