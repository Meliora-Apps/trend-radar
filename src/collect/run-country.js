// Colectarea zilnica pentru O tara: sugestii -> extindere long-tail -> topuri -> clasificare.
import { prefixesFor } from './prefixes.js';
import { CHART_TYPES, NEW_FEEDS } from '../apple/clients.js';
import { CHART_GENRES } from '../apple/genres.js';
import { scoreDay, scoreDayAdjusted, difficulty, categorize } from '../metrics/score.js';
import { buildFromDays, applyClassifications } from '../metrics/build.js';
import { rising } from '../metrics/trends.js';
import { nicheStats } from '../metrics/niche.js';
import {
  NICHE_DAYS, NICHE_APPS_MAX, RECLASSIFY_DAYS, MAX_FAILURE_RATE, EXPAND_MAX, expansionPrefixes, classificationQueue, nicheAppIds,
} from './steps.js';
import {
  dayPath, classifyPath, writeJsonGz, readCountryDays, readCountryClassifications,
} from '../data/files.js';
import { collectAppMeta } from './app-meta.js';

export {
  NICHE_DAYS, NICHE_APPS_MAX, RECLASSIFY_DAYS, MAX_FAILURE_RATE, expansionPrefixes, classificationQueue, nicheAppIds,
};

export async function runCountry({
  country, date, dataDir, apple,
  budget = {}, smoke = false, log = console.log, clock = Date.now,
}) {
  const {
    prefixes = prefixesFor(country),
    expandMax = EXPAND_MAX,
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
