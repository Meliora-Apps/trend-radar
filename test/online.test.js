// Varianta online raspunde la fel ca serverul local: exportul + web/remote-api.js fata de makeViews direct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, importAll } from '../src/local/db.js';
import { makeViews } from '../src/local/views.js';
import { buildExport, listVariants } from '../src/export/build.js';
import { shardOf } from '../src/export/shard.js';
import { makeRemoteApi } from '../web/remote-api.js';
import { writeJsonGz, dayPath, classifyPath, statsPath } from '../src/data/files.js';
import { STATS_FIELDS } from '../src/collect/app-meta.js';
import { addDays } from '../src/util/dates.js';

globalThis.location ??= { origin: 'http://test' };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tro-'));
  for (let i = 0; i < 12; i++) {
    const date = addDays('2026-01-01', i);
    const terms = ['amazon', 'airbnb'];
    if (i >= 10) terms.unshift('ai baby');
    writeJsonGz(dayPath(dir, date, 'US'), {
      date, country: 'US', complete: true, requests: 10, errors: 0,
      suggest: [{ prefix: 'a', kind: 'base', terms }],
      charts: [{ type: 'topfreeapplications', genreId: 6008, apps: [{ rank: 1, id: 1, name: 'Photo One', genreId: 6008 }, { rank: 2, id: 7, name: 'Baby Face AI', genreId: 6008 }] }],
    });
    const row = (ratings) => STATS_FIELDS.map((f) => ({ ratings, ratingsCur: 1, stars: 4.5, version: '1.0', updated: '2026-01-01', price: 0 })[f] ?? null);
    if (i >= 8) writeJsonGz(statsPath(dir, date, 'US'), { 7: row(100 + i * 20) });
  }
  writeJsonGz(classifyPath(dir, '2026-01-11', 'US'), {
    'ai baby': { category: 6008, subgenre: null, difficulty: 1, topAppIds: [7, 8], classifiedAt: '2026-01-11' },
  });
  return dir;
}

async function setup() {
  const db = openDb();
  importAll(db, fixture());
  const files = new Map();
  buildExport(db, (k, buf) => files.set(k, buf), { log: () => {}, cloud: { lastRun: '2026-01-12', finishedAt: '2026-01-12T10:00:00Z', countries: {} } });
  const actions = [];
  const convex = {
    query: async (name, { keys }) => ({ gen: 'g1', urls: keys.map((k) => (files.has(k) ? `data:application/gzip;base64,${files.get(k).toString('base64')}` : null)) }),
    action: async (name, args) => {
      actions.push([name, args]);
      if (name === 'apple:appDetail') return { country: args.country, detail: { name: 'Baby Face AI', subtitle: 'Baby generator' }, similar: [] };
      return [];
    },
  };
  return { views: makeViews(db), files, actions, api: makeRemoteApi(convex).api };
}

test('exportul: toate variantele de liste, cuvintele si app-urile in fisiere', async () => {
  const { files } = await setup();
  for (const [key] of listVariants()) assert.ok(files.has(key), key);
  assert.ok(files.has('meta') && files.has('terms'));
  assert.ok(files.has(`term/${shardOf('ai baby', 256)}`));
  assert.ok(files.has(`app/${shardOf(7, 512)}`));
});

test('online = local: liste, filtrul de categorie, cuvant, sugestii, app', async () => {
  const { views, api, actions } = await setup();
  const strip = (r) => JSON.parse(JSON.stringify(r));
  assert.deepEqual(await api('/api/view?name=new&country=US&period=7&origin=all&category=all'), strip(views.view({ name: 'new', country: 'US', period: 7, origin: 'all' })));
  assert.deepEqual(await api('/api/view?name=top&country=US&category=6008'), strip(views.view({ name: 'top', country: 'US', category: '6008' })));
  assert.deepEqual(await api('/api/view?name=top&country=US&category=none'), strip(views.view({ name: 'top', country: 'US', category: 'none' })));
  assert.deepEqual(await api('/api/niches?country=US&period=14&category=all&all=0'), strip(views.nicheView({ country: 'US', period: 14 })));
  assert.deepEqual(await api('/api/new-apps?country=US&period=90&type=all&source=charts&category=all'), strip(views.newApps({ country: 'US', launched: 90 })));
  assert.deepEqual(await api('/api/term?q=ai%20baby'), strip(views.termView('ai baby')));
  assert.equal((await api('/api/term?q=nu%20exista')).countries.length, 6);
  assert.deepEqual(await api('/api/suggest?q=a'), views.suggestTerms('a'));
  const app = await api('/api/app?id=7&country=US');
  assert.deepEqual(app.keywords.map((k) => [k.term, k.position, k.source]), [['ai baby', 1, 'title']]);
  assert.deepEqual(app.ranks, strip(views.appRanks(7)));
  assert.deepEqual(app.estimates, strip(views.appExtra(7).estimates));
  assert.deepEqual(actions[0], ['apple:appDetail', { id: 7, country: 'US' }]);
});
