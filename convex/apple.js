// Cererile "live" catre Apple (ca in serverul local): iconite, pagina unui app, recenzii, cautarea unui cuvant.
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v, ConvexError } from 'convex/values';
import { makeAppleClient, COUNTRIES } from '../src/apple/clients.js';
import { makeRetry, makeThrottle } from '../src/apple/net.js';
import { checkCandidates, hintSeeds, hintsFor, parseAppQuery } from '../src/metrics/appwords.js';
import { summarizeReviews } from '../src/metrics/reviews.js';
import { allowedEmail } from './access';

const LOOKUP_CHUNK = 100;
const NICHE_REVIEW_APPS = 5;
const apple = () => makeAppleClient({ searchMs: 1500, retry: makeRetry({ retries: 1, baseDelayMs: 2000 }) });
const country = (cc) => (COUNTRIES.includes(cc) ? cc : 'US');

export const check = internalQuery({ args: {}, handler: (ctx) => allowedEmail(ctx) });
async function guard(ctx) {
  if (!(await ctx.runQuery(internal.apple.check, {}))) throw new ConvexError('NOT_ALLOWED');
}

async function lookupAll(client, ids, cc) {
  const out = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) out.push(...await client.lookup(ids.slice(i, i + LOOKUP_CHUNK), cc));
  const byId = new Map(out.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export const lookup = action({
  args: { ids: v.array(v.number()), country: v.string() },
  handler: async (ctx, { ids, country: cc }) => {
    await guard(ctx);
    return ids.length ? lookupAll(apple(), ids.slice(0, LOOKUP_CHUNK), country(cc)) : [];
  },
});

// Cuvant inca neclasificat: primele 10 app-uri, cautate acum.
export const liveApps = action({
  args: { term: v.string(), country: v.string() },
  handler: async (ctx, { term, country: cc }) => {
    await guard(ctx);
    const client = apple();
    const t = term.trim().toLowerCase();
    if (!t) throw new ConvexError('term lipsa');
    return lookupAll(client, (await client.topApps(t, country(cc))).map((a) => a.id), country(cc));
  },
});

// Pagina unui app: metadatele + "Ti-ar mai placea" (restul vine din exportul zilnic).
export const appDetail = action({
  args: { id: v.number(), country: v.string() },
  handler: async (ctx, { id, country: cc }) => {
    await guard(ctx);
    const client = apple();
    const detail = await client.appDetail(id, country(cc));
    const similar = detail?.similarIds?.length ? await lookupAll(client, detail.similarIds, country(cc)).catch(() => []) : [];
    return { country: country(cc), detail, similar };
  },
});

export const reviews = action({
  args: { id: v.number(), country: v.string() },
  handler: async (ctx, { id, country: cc }) => {
    await guard(ctx);
    const client = apple();
    const first = await client.reviews(id, country(cc), 1);
    const second = first.length >= 50 ? await client.reviews(id, country(cc), 2).catch(() => []) : [];
    return summarizeReviews([...first, ...second]);
  },
});

// De ce se plang utilizatorii intr-o nisa: recenziile primelor 5 app-uri (ids din export sau cautate acum).
export const nicheReviews = action({
  args: { term: v.string(), country: v.string(), ids: v.optional(v.array(v.number())) },
  handler: async (ctx, { term, country: cc, ids }) => {
    await guard(ctx);
    const client = apple();
    const c = country(cc);
    const t = term.trim().toLowerCase();
    const top = ids?.length ? ids : (await client.topApps(t, c)).map((a) => a.id);
    const apps = await lookupAll(client, top.slice(0, NICHE_REVIEW_APPS), c);
    const all = [];
    for (const a of apps) all.push(...(await client.reviews(a.id, c, 1).catch(() => [])).map((r) => ({ ...r, app: a.name })));
    const names = new Set(apps.flatMap((a) => a.name.toLowerCase().split(/[^\p{L}\p{N}']+/u)).filter(Boolean));
    return { ...summarizeReviews(all, 12, names), apps: apps.map((a) => ({ id: a.id, name: a.name, icon: a.icon })) };
  },
});

// "Verifica acum" pe pagina unui app, pasul 1: ce cuvinte verificam (vezi checkCandidates).
// Sugestiile App Store le cerem pentru perechile de cuvinte din nume (vezi hintSeeds).
const CHECK_MAX = 40;
const CHECK_HINT_SEEDS = 3;
export const checkPlan = action({
  args: { country: v.string(), name: v.string(), subtitle: v.optional(v.string()), known: v.array(v.string()) },
  handler: async (ctx, { country: cc, name, subtitle, known }) => {
    await guard(ctx);
    const client = apple();
    const hints = [];
    for (const s of hintSeeds(name, CHECK_HINT_SEEDS)) hints.push(...hintsFor(s, await client.suggest(s, country(cc)).catch(() => [])));
    return checkCandidates({ name, subtitle, known: known.slice(0, CHECK_MAX), hints, max: CHECK_MAX });
  },
});

// Pasul 2: locul real in cautare (top 200), cate o bucata mica de cuvinte pe apel (site-ul arata progresul).
// Acelasi ritm sigur ca robotul (~19 cautari/min), ca Apple sa nu raspunda 403.
const CHECK_BATCH = 6;
export const checkRanks = action({
  args: { id: v.number(), country: v.string(), terms: v.array(v.string()) },
  handler: async (ctx, { id, country: cc, terms }) => {
    await guard(ctx);
    const client = makeAppleClient({ searchThrottle: makeThrottle(3200), retry: makeRetry({ retries: 2, baseDelayMs: 10_000 }) });
    const out = [];
    for (const term of terms.slice(0, CHECK_BATCH)) {
      try {
        out.push({ term, ...await client.searchRank(term, country(cc), id) });
      } catch (err) {
        out.push({ term, position: null, total: 0, error: err.message });
      }
    }
    return out;
  },
});

// "Cauta aplicatie": dupa link App Store / id (direct) sau dupa nume (primele 10 din cautarea App Store).
export const findApps = action({
  args: { query: v.string(), country: v.string() },
  handler: async (ctx, { query: text, country: cc }) => {
    await guard(ctx);
    const q = parseAppQuery(text);
    if (!q) return { country: country(cc), apps: [] };
    const client = apple();
    const c = country(q.country ?? cc);
    const ids = q.id ? [q.id] : (await client.topApps(q.term, c)).map((a) => a.id);
    return { country: c, apps: ids.length ? await lookupAll(client, ids, c) : [] };
  },
});
