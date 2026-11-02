// Server local (fara dependinte): API JSON + fisierele interfetei.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeViews } from './views.js';
import { importAll } from './db.js';
import { makeAppleClient, COUNTRIES } from '../apple/clients.js';
import { makeRetry } from '../apple/net.js';
import { genreName } from '../apple/genres.js';
import { keywordSource } from '../metrics/appwords.js';
import { summarizeReviews } from '../metrics/reviews.js';
import { toCsv } from './csv.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const STALE_HOURS = 48;

export { toCsv };

const LOOKUP_CHUNK = 100;
const NICHE_REVIEW_APPS = 5;

function readCloudStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function createServer({ db, dataDir, refresh = async () => ({}), apple = makeAppleClient({ searchMs: 1500, retry: makeRetry({ retries: 1, baseDelayMs: 2000 }) }) }) {
  const views = makeViews(db);
  const appCache = new Map(); // `${cc}:${id}` -> app

  async function lookupApps(ids, cc) {
    const missing = ids.filter((id) => !appCache.has(`${cc}:${id}`));
    for (let i = 0; i < missing.length; i += LOOKUP_CHUNK) {
      for (const a of await apple.lookup(missing.slice(i, i + LOOKUP_CHUNK), cc)) appCache.set(`${cc}:${a.id}`, a);
    }
    return ids.map((id) => appCache.get(`${cc}:${id}`)).filter(Boolean);
  }

  const routes = {
    '/api/status': () => {
      const cloud = readCloudStatus(dataDir);
      const ageHours = cloud?.finishedAt ? (Date.now() - Date.parse(cloud.finishedAt)) / 3.6e6 : null;
      return { cloud, stale: ageHours == null || ageHours > STALE_HOURS, ageHours, local: views.status() };
    },
    '/api/meta': () => ({ countries: COUNTRIES, categories: views.categories() }),
    '/api/view': (q) => views.view({ name: q.get('name'), country: q.get('country'), category: q.get('category'), period: q.get('period'), origin: q.get('origin') ?? 'all' }),
    '/api/themes': (q) => views.themeView({ country: q.get('country'), category: q.get('category') ?? 'all' }),
    '/api/term': (q) => views.termView(q.get('q') ?? ''),
    '/api/suggest': (q) => views.suggestTerms(q.get('q') ?? ''),
    '/api/apps': async (q) => {
      const ids = (q.get('ids') ?? '').split(',').map(Number).filter(Boolean).slice(0, LOOKUP_CHUNK);
      const cc = COUNTRIES.includes(q.get('country')) ? q.get('country') : 'US';
      return ids.length ? lookupApps(ids, cc) : [];
    },
    // Cuvant inca neclasificat: cautam live primele 10 app-uri (o singura cerere, apoi din cache).
    '/api/live-apps': async (q) => {
      const term = (q.get('term') ?? '').trim().toLowerCase();
      const cc = COUNTRIES.includes(q.get('country')) ? q.get('country') : 'US';
      if (!term) throw new Error('term lipsa');
      const key = `live:${cc}:${term}`;
      if (!appCache.has(key)) appCache.set(key, (await apple.topApps(term, cc)).map((a) => a.id));
      return lookupApps(appCache.get(key), cc);
    },
    '/api/app': async (q) => {
      const id = Number(q.get('id'));
      const cc = COUNTRIES.includes(q.get('country')) ? q.get('country') : 'US';
      if (!id) throw new Error('id lipsa');
      const key = `detail:${cc}:${id}`;
      if (!appCache.has(key)) appCache.set(key, await apple.appDetail(id, cc));
      const detail = appCache.get(key);
      const keywords = views.appKeywords(id).map((k) => ({
        ...k, source: detail && k.country === cc ? keywordSource(k.term, detail.name, detail.subtitle) : null,
      }));
      // "Ti-ar mai placea": aceeasi nisa (icon, nume, rating-uri) dintr-un singur lookup.
      const similar = detail?.similarIds?.length ? await lookupApps(detail.similarIds, cc).catch(() => []) : [];
      return { country: cc, detail, keywords, ranks: views.appRanks(id), similar, ...views.appExtra(id) };
    },
    // Recenziile recente (2 pagini = pana la 100) + rezumatul plangerilor.
    '/api/reviews': async (q) => {
      const id = Number(q.get('id'));
      const cc = COUNTRIES.includes(q.get('country')) ? q.get('country') : 'US';
      if (!id) throw new Error('id lipsa');
      const key = `reviews:${cc}:${id}`;
      if (!appCache.has(key)) {
        const first = await apple.reviews(id, cc, 1);
        const second = first.length >= 50 ? await apple.reviews(id, cc, 2).catch(() => []) : [];
        appCache.set(key, summarizeReviews([...first, ...second]));
      }
      return appCache.get(key);
    },
    // De ce se plang utilizatorii intr-o nisa: recenziile recente ale primelor 5 app-uri, adunate.
    '/api/niche-reviews': async (q) => {
      const term = (q.get('term') ?? '').trim().toLowerCase();
      const cc = COUNTRIES.includes(q.get('country')) ? q.get('country') : 'US';
      if (!term) throw new Error('term lipsa');
      const key = `nreviews:${cc}:${term}`;
      if (!appCache.has(key)) {
        let ids = views.termApps(term, cc);
        if (!ids) ids = (await apple.topApps(term, cc)).map((a) => a.id);
        const apps = await lookupApps(ids.slice(0, NICHE_REVIEW_APPS), cc);
        const all = [];
        for (const a of apps) all.push(...(await apple.reviews(a.id, cc, 1).catch(() => [])).map((r) => ({ ...r, app: a.name })));
        const names = new Set(apps.flatMap((a) => a.name.toLowerCase().split(/[^\p{L}\p{N}']+/u)).filter(Boolean));
        appCache.set(key, { ...summarizeReviews(all, 12, names), apps: apps.map((a) => ({ id: a.id, name: a.name, icon: a.icon })) });
      }
      return appCache.get(key);
    },
    '/api/breakouts': (q) => views.breakoutView({ country: q.get('country'), category: q.get('category') }),
    '/api/changes': (q) => views.changesView({ country: q.get('country'), category: q.get('category'), period: q.get('period'), who: q.get('who') ?? 'money' }),
    '/api/new-apps': (q) => views.newApps({ country: q.get('country'), category: q.get('category'), type: q.get('type') ?? 'all', launched: q.get('period'), source: q.get('source') ?? 'charts' }),
    '/api/niches': (q) => views.nicheView({ country: q.get('country'), category: q.get('category'), period: q.get('period'), all: q.get('all') === '1' }),
    '/api/genre': (q) => ({ name: genreName(Number(q.get('id'))) }),
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const r = await refresh();
        views.invalidate();
        return sendJson(res, r);
      }
      if (url.pathname === '/api/csv') {
        const v = views.view({ name: url.searchParams.get('name'), country: url.searchParams.get('country'), category: url.searchParams.get('category'), period: url.searchParams.get('period'), origin: url.searchParams.get('origin') ?? 'all', limit: Infinity });
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="trend-radar-${url.searchParams.get('name')}.csv"` });
        return res.end(`﻿${toCsv(v.rows)}`);
      }
      const route = routes[url.pathname];
      if (route) return sendJson(res, await route(url.searchParams));
      return serveStatic(url.pathname, res);
    } catch (err) {
      console.error(err);
      sendJson(res, { error: err.message }, 500);
    }
  });
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(pathname, res) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export { importAll };
