// Logica pura a colectarii zilnice (fara fisiere): ce intrebam, in ce ordine, si ce iese din raspunsuri.
// O folosesc si colectarea din Convex (convex/collect.js), si cea din linia de comanda (run-country.js).
import { newTerms, rising } from '../metrics/trends.js';
import { addDays } from '../util/dates.js';

export const NEW_PRIORITY_DAYS = 7;
export const NICHE_DAYS = 14;
export const NICHE_APPS_MAX = 15000; // ~150 cereri lookup (100 id-uri/cerere)
export const RECLASSIFY_DAYS = 30;
export const MAX_FAILURE_RATE = 0.1;
export const EXPAND_MAX = 300;

export const LOOKUP_BATCH = 100;
// Ordinea campurilor din data/stats (tablou compact, ca fisierul zilnic sa ramana mic).
export const STATS_FIELDS = ['ratings', 'ratingsCur', 'stars', 'version', 'updated', 'price'];
export const NOTES_MAX = 600;
const VERSION = STATS_FIELDS.indexOf('version');

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
// Apoi cele in crestere (`hot`) clasificate inainte de scorul de nisa: le refacem ca sa aiba concurenta
// (si cele masurate inainte de "sansa ta": fara weak/fresh90/stale). La fel cele vazute doar dupa combinatii
// rare de litere (`rare`): app-ul cel mai mare din top decide daca isi pastreaza scorul intreg in interfata.
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

// App-urile de verificat azi: cele din topuri, apoi lansarile noi si app-urile din nisele calde.
export const lookupIds = (charts, extraIds, max = Infinity) =>
  [...new Set([...charts.flatMap((c) => c.apps.map((a) => a.id)), ...extraIds])].filter(Boolean).slice(0, max);

// Raspunsurile lookup ale zilei -> fisierele zilei:
//  - meta:    datele stabile (data lansarii etc.), doar pentru app-urile inca necunoscute (`known`);
//  - stats:   cifrele zilei pentru toate: rating-uri (semnul descarcarilor), versiune, pret;
//  - changes: ce s-a schimbat fata de ziua precedenta: nume (`names` = numele actuale), versiune noua fata de
//             `prev` (cifrele ultimei zile), cu textul noutatilor doar la cei din topul incasarilor (`grossing`).
export function appFiles({ date, results, known, names, prev = {}, grossing = new Set() }) {
  const meta = {};
  const stats = {};
  const changes = [];
  for (const m of results) {
    stats[m.id] = STATS_FIELDS.map((f) => m[f]);
    const oldName = names.get(m.id);
    if (oldName && m.name && oldName !== m.name) changes.push({ id: m.id, field: 'name', from: oldName, to: m.name });
    const oldVersion = prev[m.id]?.[VERSION];
    if (oldVersion && m.version && oldVersion !== m.version) {
      changes.push({
        id: m.id, field: 'version', from: oldVersion, to: m.version,
        ...(grossing.has(m.id) && m.notes ? { notes: m.notes.slice(0, NOTES_MAX) } : {}),
      });
    }
    if (!known.has(m.id)) {
      meta[m.id] = { name: m.name, genreId: m.genreId, releaseDate: m.releaseDate, seller: m.seller, seenAt: date };
    }
  }
  return { meta, stats, changes };
}

export const grossingIds = (charts) =>
  new Set(charts.filter((c) => c.type === 'topgrossingapplications').flatMap((c) => c.apps.map((a) => a.id)));
