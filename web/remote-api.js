// API-ul interfetei (cererile /api/... din src/local/public/app.js): raspunsurile vin
// din fisierele exportate zilnic in Convex (src/export/build.js) + actiunile live catre Apple (convex/apple.js).
import { COUNTRIES } from '../src/apple/clients.js';
import { keywordSource } from '../src/metrics/appwords.js';
import { saturated } from '../src/metrics/niche.js';
import { shardOf, TERM_SHARDS, APP_SHARDS } from '../src/export/shard.js';
import { toCsv } from '../src/local/csv.js';

const MAX_ROWS = 1500;
const STALE_HOURS = 48;

export function makeRemoteApi(convex) {
  const files = new Map(); // cheie -> Promise<obiect>, pentru generatia curenta
  let gen = null;

  async function gunzipJson(res) {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function load(keys) {
    const missing = keys.filter((k) => !files.has(k));
    if (missing.length) {
      const pending = convex.query('data:urls', { keys: missing }).then((r) => {
        if (gen && r.gen !== gen) files.clear(); // a venit o generatie noua: tot ce e in memorie e vechi
        gen = r.gen;
        return r.urls;
      });
      missing.forEach((k, i) => files.set(k, pending.then(async (urls) => {
        if (!urls[i]) return null;
        const res = await fetch(urls[i]);
        if (!res.ok) throw new Error(`Fișierul ${k}: HTTP ${res.status}`);
        return gunzipJson(res);
      }).catch((err) => { files.delete(k); throw err; })));
    }
    return Promise.all(keys.map((k) => files.get(k)));
  }
  const one = async (key) => (await load([key]))[0];

  // Filtrul de categorie al serverului: cuvintele dupa `category`, aplicatiile dupa `genreId`.
  const inCategory = (category) => (r) => {
    if (category == null || category === '' || category === 'all') return true;
    const v = 'category' in r ? r.category : r.genreId;
    if (category === 'none') return v == null;
    return v === Number(category);
  };
  const page = (rows, extra = {}) => ({ total: rows.length, rows: rows.slice(0, MAX_ROWS), ...extra });

  function listKey(q) {
    const cc = q.get('country') ?? 'US';
    const name = q.get('name');
    const p = Number(q.get('period')) || 7;
    if (name === 'new') return `list/${cc}/new/${[1, 7, 30].includes(p) ? p : 7}/${q.get('origin') ?? 'all'}`;
    if (name === 'rising' || name === 'falling') return `list/${cc}/${name}/${p >= 30 ? 30 : 7}`;
    if (name === 'gone') return `list/${cc}/gone`;
    return `list/${cc}/top`;
  }

  const emptyTerm = (t) => ({
    term: t,
    saturated: saturated(t),
    countries: COUNTRIES.map((country) => ({
      country, history: [], last: null, firstSeen: null, lastSeen: null, category: null, subgenre: null,
      difficulty: null, topAppIds: [], niche: null, competition: null, chance: null, market: null,
    })),
  });
  const termOf = async (t) => (await one(`term/${shardOf(t, TERM_SHARDS)}`))?.[t] ?? emptyTerm(t);

  const routes = {
    '/api/status': async () => {
      const m = await one('meta');
      const cloud = m?.cloud ?? null;
      const ageHours = cloud?.finishedAt ? (Date.now() - Date.parse(cloud.finishedAt)) / 3.6e6 : null;
      return { cloud, stale: ageHours == null || ageHours > STALE_HOURS, ageHours, local: m?.status ?? { countries: {}, problems: [] } };
    },
    '/api/meta': async () => {
      const m = await one('meta');
      return { countries: m?.countries ?? COUNTRIES, categories: m?.categories ?? [] };
    },
    '/api/view': async (q) => {
      const r = await one(listKey(q));
      if (!r) return { total: 0, rows: [], meta: {} };
      return page(r.rows.filter(inCategory(q.get('category'))), { meta: r.meta });
    },
    '/api/niches': async (q) => {
      const p = [7, 14, 30].includes(Number(q.get('period'))) ? Number(q.get('period')) : 14;
      const r = await one(`list/${q.get('country') ?? 'US'}/niches/${p}`);
      if (!r) return { total: 0, rows: [], measured: 0, hidden: {} };
      const inCat = r.rows.filter(inCategory(q.get('category')));
      const hidden = { few: 0, money: 0, lang: 0, brand: 0, code: 0, mixed: 0 };
      for (const x of inCat) if (x.notNiche) hidden[x.notNiche]++;
      const out = q.get('all') === '1' ? inCat : inCat.filter((x) => !x.notNiche);
      return page(out, { measured: out.filter((x) => x.competition != null).length, hidden });
    },
    '/api/breakouts': async (q) => {
      const r = await one(`list/${q.get('country') ?? 'US'}/breakouts`);
      if (!r) return { total: 0, rows: [], measured: 0 };
      return page(r.rows.filter(inCategory(q.get('category'))), { measured: r.measured });
    },
    '/api/changes': async (q) => {
      const p = [7, 14, 30].includes(Number(q.get('period'))) ? Number(q.get('period')) : 7;
      const r = await one(`list/${q.get('country') ?? 'US'}/changes/${p}/${q.get('who') === 'all' ? 'all' : 'money'}`);
      return r ? page(r.rows.filter(inCategory(q.get('category')))) : { total: 0, rows: [] };
    },
    '/api/new-apps': async (q) => {
      const cc = q.get('country') ?? 'US';
      const launched = [30, 90, 180, 365].includes(Number(q.get('period'))) ? Number(q.get('period')) : 90;
      const key = q.get('source') === 'feed' ? `list/${cc}/apps/feed/${launched}` : `list/${cc}/apps/charts/${launched}/${q.get('type') ?? 'all'}`;
      const r = await one(key);
      return r ? page(r.rows.filter(inCategory(q.get('category')))) : { total: 0, rows: [] };
    },
    '/api/upcoming': async (q) => {
      const r = await one(`list/${q.get('country') ?? 'US'}/upcoming`);
      if (!r) return { total: 0, rows: [], latest: null, waves: {} };
      const status = q.get('status') === 'launched' ? 'launched' : 'preorder';
      return page(r[status].filter(inCategory(q.get('category'))), { latest: r.latest, waves: r.waves, other: r[status === 'launched' ? 'preorder' : 'launched'].length });
    },
    '/api/themes': async (q) => {
      const all = (await one(`list/${q.get('country') ?? 'US'}/themes`)) ?? [];
      const c = q.get('category') ?? 'all';
      return c === 'all' ? all : all.filter((g) => g.genreId === Number(c));
    },
    '/api/term': (q) => termOf((q.get('q') ?? '').trim().toLowerCase()),
    '/api/suggest': async (q) => {
      const t = (q.get('q') ?? '').trim().toLowerCase();
      const terms = (await one('terms')) ?? [];
      const out = [];
      for (const x of terms) { if (x.startsWith(t)) out.push(x); if (out.length >= 15) break; }
      return out;
    },
    '/api/apps': async (q) => {
      const ids = (q.get('ids') ?? '').split(',').map(Number).filter(Boolean).slice(0, 100);
      return ids.length ? convex.action('apple:lookup', { ids, country: q.get('country') ?? 'US' }) : [];
    },
    '/api/live-apps': (q) => convex.action('apple:liveApps', { term: q.get('term') ?? '', country: q.get('country') ?? 'US' }),
    '/api/app': async (q) => {
      const id = Number(q.get('id'));
      const cc = q.get('country') ?? 'US';
      const [live, shard] = await Promise.all([
        convex.action('apple:appDetail', { id, country: cc }),
        one(`app/${shardOf(id, APP_SHARDS)}`),
      ]);
      const p = shard?.[id] ?? { keywords: [], ranks: { downloads: [], grossing: [], ratings: [] }, estimates: [], changes: [] };
      const d = live.detail;
      const keywords = p.keywords.map((k) => ({ ...k, source: d && k.country === live.country ? keywordSource(k.term, d.name, d.subtitle) : null }));
      return { country: live.country, detail: d, keywords, ranks: p.ranks, similar: live.similar, estimates: p.estimates, changes: p.changes };
    },
    '/api/reviews': (q) => convex.action('apple:reviews', { id: Number(q.get('id')), country: q.get('country') ?? 'US' }),
    '/api/niche-reviews': async (q) => {
      const t = (q.get('term') ?? '').trim().toLowerCase();
      const cc = q.get('country') ?? 'US';
      const ids = (await termOf(t)).countries.find((c) => c.country === cc)?.topAppIds ?? [];
      return convex.action('apple:nicheReviews', { term: t, country: cc, ...(ids.length ? { ids } : {}) });
    },
    // Online nu e nimic de descarcat: datele noi apar singure; doar golim memoria ca sa le recitim.
    '/api/refresh': async () => { files.clear(); return {}; },
  };

  async function api(path) {
    const url = new URL(path, location.origin);
    const route = routes[url.pathname];
    if (!route) throw new Error(`Necunoscut: ${url.pathname}`);
    return route(url.searchParams);
  }

  // Butonul CSV: aceeasi lista ca pe ecran, toate randurile, salvata ca fisier.
  async function csv(href) {
    const q = new URL(href, location.origin).searchParams;
    const r = await one(listKey(q));
    const rows = (r?.rows ?? []).filter(inCategory(q.get('category')));
    const blob = new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `trend-radar-${q.get('name')}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return { api, csv };
}
