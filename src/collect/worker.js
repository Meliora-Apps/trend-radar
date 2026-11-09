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
// In Convex fiecare tara are doua benzi, care merg in paralel: cuvintele (sugestiile, apoi clasificarea lor) si
// app-urile (topuri, lansari noi, lookup, precomenzi). Folosesc servere Apple diferite (search.itunes.apple.com /
// itunes.apple.com), iar pasii unei benzi au nevoie doar de ce a cules aceeasi banda (vezi PREP_NEEDS in
// convex/collect.js). Un job fara `lane` (linia de comanda, colectarile vechi) face toti pasii, pe rand (PHASES).
export const LANES = {
  words: ['base', 'expand', 'classify', 'done'],
  apps: ['charts', 'feed', 'lookup', 'upcoming', 'done'],
};
export const CLASSIFY_MS = 3 * 3600_000;
// Cautarea iTunes (classify, upcoming) are limita Apple de ~20 de cereri pe minut de pe o adresa; peste ea (si pe
// adresele comune ale Convex, unde o folosesc si altii) raspunde cu HTTP 403. Dupa atatea 403 la rand, pasul se
// opreste in loc sa treaca prin toata lista.
export const SEARCH_BLOCKED_AFTER = 5;
// La fel dupa atatea 403 la rand in toate benzile (`gate`, comun, pastrat de la o bucata la alta): blocajul se
// vede mai repede. Un sir de refuzuri mai vechi de SEARCH_GATE_STALE_MS nu mai conteaza (o banda care ajunge
// mai tarziu la cautare incearca din nou).
export const SEARCH_BLOCKED_SHARED = 12;
export const SEARCH_GATE_STALE_MS = 5 * 60_000;
const SEARCH_PHASES = new Set(['classify', 'upcoming']);
// In Convex, job.searchUntil (vezi collect.start) incheie pasii cu cautare la o ora fixa, ca ziua sa se termine
// la timp (la 20 de cereri pe minut, clasificarea intreaga ar dura ore); fiecare are totusi cel putin
// SEARCH_MIN_MS. Coada clasificarii incepe cu cuvintele noi si cele mari, iar restul ramane pentru zilele urmatoare.
export const SEARCH_MIN_MS = 3 * 60_000;
function searchDeadline(j, now) {
  const cap = j.phase === 'classify' ? now + CLASSIFY_MS : Infinity;
  return j.searchUntil == null ? cap : Math.min(cap, Math.max(j.searchUntil, now + SEARCH_MIN_MS));
}

export const newJob = (country, date, lane = null) => ({
  country, date, ...(lane ? { lane } : {}), phase: lane ? LANES[lane][0] : 'base', pos: 0, requests: 0, failures: 0,
  aborted: false, suggested: 0, keywordsOk: null, classifyUntil: null,
});

// Benzile unei tari -> o singura stare, pentru assembleDay: cuvintele decid daca ziua e completa,
// cererile si erorile se aduna.
export function dayJob(jobs) {
  if (jobs.length === 1) return jobs[0];
  const words = jobs.find((j) => j.lane === 'words') ?? jobs[0];
  return { ...words, requests: jobs.reduce((n, j) => n + j.requests, 0), failures: jobs.reduce((n, j) => n + j.failures, 0) };
}

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

const next = (job) => {
  const seq = job.lane ? LANES[job.lane] : PHASES;
  return seq[seq.indexOf(job.phase) + 1];
};

// O bucata de lucru: continua pasul curent pana la `deadline`. Intoarce { job (starea noua), out (ce s-a cules) }.
// Cand pasul se termina, job.phase trece la urmatorul (care trebuie pregatit cu preparePhase inainte de bucata urmatoare).
export async function work(job, { apple, items, prep, deadline, clock = Date.now, log = console.log, gate = { denied: 0 } }) {
  const gateShut = () => {
    if (gate.at != null && clock() - gate.at > SEARCH_GATE_STALE_MS) Object.assign(gate, { denied: 0, at: undefined });
    return gate.denied >= SEARCH_BLOCKED_SHARED;
  };
  const gateSaw = (refused) => Object.assign(gate, refused ? { denied: gate.denied + 1, at: clock() } : { denied: 0, at: undefined });
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
  if (j.phase === 'classify' && j.classifyUntil == null) j.classifyUntil = searchDeadline(j, clock());
  if (j.phase === 'upcoming' && j.upcomingUntil == null && j.searchUntil != null) j.upcomingUntil = searchDeadline(j, clock());
  const until = j.phase === 'classify' ? j.classifyUntil : j.phase === 'upcoming' ? (j.upcomingUntil ?? Infinity) : Infinity;
  const grossing = j.phase === 'lookup' ? new Set(prep?.grossing ?? []) : null;
  const out = [];
  let ended = false;
  const search = SEARCH_PHASES.has(j.phase);
  let denied = j.denied ?? 0; // 403 la rand, in pasii cu cautare (si peste bucati)
  while (clock() < deadline) {
    if (stop() || j.pos >= items.length || clock() > until) { ended = true; break; }
    if (search && (denied >= SEARCH_BLOCKED_AFTER || gateShut())) {
      log(`[${j.country}] ${j.phase}: cautarea Apple e blocata pentru aceasta adresa (HTTP 403 de ${Math.max(denied, gate.denied)} ori la rand${denied < SEARCH_BLOCKED_AFTER ? ', in toate tarile' : ''}) -> sar peste pas`);
      (j.blocked ??= []).push(j.phase);
      ended = true;
      break;
    }
    const item = items[j.pos];
    try {
      out.push(await doItem(j, item, apple, grossing));
      if (j.phase === 'base' || j.phase === 'expand') j.suggested++;
      denied = 0;
      if (search) gateSaw(false);
    } catch (err) {
      if (err.outOfTime) break; // nu mai incape in bucata: ramane pentru urmatoarea
      log(`[${j.country}] ${j.phase} ${JSON.stringify(item).slice(0, 60)} esuat: ${err.message}`);
      const refused = search && err.status === 403;
      denied = refused ? denied + 1 : 0;
      if (search) gateSaw(refused);
    }
    j.pos++;
  }
  if (!ended && (stop() || j.pos >= items.length)) ended = true;
  Object.assign(j, { requests: counter.stats.requests, failures: counter.stats.failures, denied: ended ? 0 : denied });
  if (ended) {
    if (j.phase === 'expand' || j.aborted) {
      // Ziua e completa daca am cules cuvintele (pasii base + expand), ca in runCountry.
      j.keywordsOk ??= !j.smoke && !j.aborted && counter.failureRate() <= MAX_FAILURE_RATE && j.suggested > 0;
    }
    j.phase = j.aborted ? 'done' : next(j);
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
