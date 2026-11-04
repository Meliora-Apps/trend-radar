// Colectarea unei tari pe bucati (pentru Convex: o actiune are cel mult 10 minute si 64 MB).
// Aceiasi pasi ca runCountry (run-country.js), dar starea se pastreaza intre bucati in `job`, iar fiecare
// bucata intoarce doar ce a cules ea. La final, assembleDay (mai jos) face din bucati fisierele zilei.
import { prefixesFor } from './prefixes.js';
import { CHART_TYPES, NEW_FEEDS } from '../apple/clients.js';
import { CHART_GENRES } from '../apple/genres.js';
import { scoreDay, scoreDayAdjusted, difficulty, categorize } from '../metrics/score.js';
import { nicheStats } from '../metrics/niche.js';
import { MAX_FAILURE_RATE, EXPAND_MAX, LOOKUP_BATCH, UPCOMING_TERMS, classificationQueue, lookupIds, grossingIds } from './steps.js';

// Precomenzile (upcoming) dupa lookup: daca Apple blocheaza cautarea, se pierde doar clasificarea, ca pana acum.
export const PHASES = ['base', 'expand', 'charts', 'feed', 'lookup', 'upcoming', 'classify', 'done'];
export const CLASSIFY_MS = 3 * 3600_000;

export const newJob = (country, date) => ({
  country, date, phase: 'base', pos: 0, requests: 0, failures: 0, aborted: false, suggested: 0, keywordsOk: null,
  classifyUntil: null,
});

// Lucrurile de facut in fiecare pas. `prep` = listele pregatite la trecerea in pas (vezi preparePhase).
// Proba scurta (job.smoke): putine cereri din fiecare pas, ziua nu conteaza ca zi completa.
const SMOKE = { base: 30, expand: 10, charts: 6, feed: 2, lookup: 2, upcoming: 3, classify: 20 };

export function phaseItems(job, prep) {
  const items = allItems(job, prep);
  return job.smoke ? items.slice(0, SMOKE[job.phase] ?? 0) : items;
}

function allItems(job, prep) {
  switch (job.phase) {
    case 'base': return prefixesFor(job.country);
    case 'charts': return CHART_GENRES.flatMap((genreId) => CHART_TYPES.map((type) => ({ genreId, type })));
    case 'feed': return NEW_FEEDS;
    case 'expand': case 'upcoming': case 'classify': return prep ?? [];
    case 'lookup': {
      const ids = prep?.ids ?? [];
      return Array.from({ length: Math.ceil(ids.length / LOOKUP_BATCH) }, (_, i) => ids.slice(i * LOOKUP_BATCH, (i + 1) * LOOKUP_BATCH));
    }
    default: return [];
  }
}

// Ce trebuie pregatit (o singura data) la intrarea in pas, din planul zilei si din ce s-a cules deja:
//  expand:   inceputurile de extins (din plan), fara cele de baza;
//  lookup:   app-urile de verificat (topuri + lansari noi + nisele calde + precomenzile din plan) si cele din topul incasarilor;
//  upcoming: cuvintele pentru precomenzi (cele fixe + numele jocurilor care fac bani, din plan);
//  classify: coada de clasificare (cuvintele de azi, cele noi primele).
export function preparePhase(job, { plan, parts }) {
  if (job.phase === 'expand') {
    const base = new Set(prefixesFor(job.country));
    return (plan?.expand ?? []).slice(0, EXPAND_MAX).filter((p) => !base.has(p));
  }
  if (job.phase === 'lookup') {
    const charts = parts.charts ?? [];
    const feedIds = (parts.feed ?? []).flatMap((f) => f.apps.map((a) => a.id));
    return { ids: lookupIds(charts, [...feedIds, ...(plan?.nicheIds ?? []), ...(plan?.upcomingIds ?? [])]), grossing: [...grossingIds(charts)] };
  }
  if (job.phase === 'upcoming') return plan?.upcomingTerms ?? UPCOMING_TERMS;
  if (job.phase === 'classify') {
    const suggest = [...(parts.base ?? []), ...(parts.expand ?? [])];
    const todayScores = scoreDay(suggest);
    const adjusted = scoreDayAdjusted(suggest);
    const rare = new Set([...todayScores.keys()].filter((t) => adjusted.get(t) < todayScores.get(t)));
    return classificationQueue(planIndex(plan), todayScores, job.date, new Set(plan?.hot ?? []), rare);
  }
  return null;
}

// Indexul din plan (vezi src/compute/plan.js) in forma ceruta de classificationQueue.
export function planIndex(plan) {
  const index = new Map();
  for (const [term, [firstSeen, classifiedAt, weak, tmax]] of Object.entries(plan?.terms ?? {})) {
    index.set(term, { firstSeen, classifiedAt, niche: { weak, tmax } });
  }
  return index;
}

const next = (phase) => PHASES[PHASES.indexOf(phase) + 1];

// O bucata de lucru: continua pasul curent pana la `deadline`. Intoarce { job (starea noua), out (ce s-a cules) }.
// Cand pasul se termina, job.phase trece la urmatorul (care trebuie pregatit cu preparePhase inainte de bucata urmatoare).
export async function work(job, { apple, items, prep, deadline, clock = Date.now, log = console.log }) {
  const j = { ...job };
  const { counter } = apple;
  Object.assign(counter.stats, { requests: j.requests, failures: j.failures });
  const stop = () => {
    if (!j.aborted && counter.tooManyFailures(50, MAX_FAILURE_RATE)) {
      j.aborted = true;
      log(`[${j.country}] prea multe erori (${counter.stats.failures}/${counter.stats.requests}) -> opresc colectarea`);
    }
    return j.aborted;
  };
  if (j.phase === 'classify' && j.classifyUntil == null) j.classifyUntil = clock() + CLASSIFY_MS;
  const grossing = j.phase === 'lookup' ? new Set(prep?.grossing ?? []) : null;
  const out = [];
  let ended = false;
  while (clock() < deadline) {
    if (stop() || j.pos >= items.length || (j.phase === 'classify' && clock() > j.classifyUntil)) { ended = true; break; }
    const item = items[j.pos];
    try {
      out.push(await doItem(j, item, apple, grossing));
      if (j.phase === 'base' || j.phase === 'expand') j.suggested++;
    } catch (err) {
      log(`[${j.country}] ${j.phase} ${JSON.stringify(item).slice(0, 60)} esuat: ${err.message}`);
    }
    j.pos++;
  }
  if (!ended && (stop() || j.pos >= items.length)) ended = true;
  Object.assign(j, { requests: counter.stats.requests, failures: counter.stats.failures });
  if (ended) {
    if (j.phase === 'expand' || j.aborted) {
      // Ziua e completa daca am cules cuvintele (pasii base + expand), ca in runCountry.
      j.keywordsOk ??= !j.smoke && !j.aborted && counter.failureRate() <= MAX_FAILURE_RATE && j.suggested > 0;
    }
    j.phase = j.aborted ? 'done' : next(j.phase);
    j.pos = 0;
  }
  return { job: j, out };
}

async function doItem(job, item, apple, grossing) {
  const cc = job.country;
  switch (job.phase) {
    case 'base': case 'expand':
      return { prefix: item, kind: job.phase, terms: await apple.suggest(item, cc) };
    case 'charts':
      return { type: item.type, genreId: item.genreId, apps: await apple.chart(cc, item.type, item.genreId) };
    case 'feed':
      return { type: item, apps: await apple.newFeed(cc, item) };
    case 'lookup': {
      // Item = un lot de cel mult 100 de id-uri. Textul noutatilor il pastram doar la cei care fac bani.
      const results = await apple.appMeta(item, cc);
      return results.map((m) => ({ ...m, notes: grossing.has(m.id) ? m.notes : '' }));
    }
    case 'upcoming':
      return { term: item, apps: await apple.upcoming(item, cc, job.date) };
    case 'classify': {
      const apps = await apple.topApps(item, cc);
      return [item, {
        ...categorize(apps),
        difficulty: difficulty(apps.map((a) => a.ratings)),
        topAppIds: apps.map((a) => a.id),
        niche: nicheStats(apps, item, job.date),
        classifiedAt: job.date,
      }];
    }
    default: throw new Error(`pas necunoscut: ${job.phase}`);
  }
}

// Bucatile culese -> continutul fisierelor zilei (days + classify) si raspunsurile lookup (pentru apps/stats/changes).
// parts: { base, expand, charts, feed, lookup: [[...], ...], upcoming: [{ term, apps }], classify: [[term, c], ...] }
export function assembleDay(job, parts) {
  const suggest = [...(parts.base ?? []), ...(parts.expand ?? [])];
  return {
    day: {
      date: job.date, country: job.country, complete: !!job.keywordsOk, smoke: false,
      requests: job.requests, errors: job.failures, suggest, charts: parts.charts ?? [], newFeed: parts.feed ?? [],
      upcoming: parts.upcoming ?? [],
    },
    classify: Object.fromEntries(parts.classify ?? []),
    lookup: (parts.lookup ?? []).flat(),
    charts: parts.charts ?? [],
  };
}
