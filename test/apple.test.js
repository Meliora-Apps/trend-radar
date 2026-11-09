import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHints, parseSearch, parseChart, parseAppMeta, parseIap, parseSimilar, parseReviews, makeAppleClient } from '../src/apple/clients.js';
import { makeThrottle, makeRetry, makeCounter, HttpError } from '../src/apple/net.js';

const HINTS = `<?xml version="1.0"?><plist version="1.0"><dict><key>title</key><string>Suggestions</string>
<key>hints</key><array>
<dict><key>term</key><string>AI Chat</string><key>url</key><string>https://x?a=1&amp;b=2</string></dict>
<dict><key>term</key><string>tom &amp; jerry</string><key>url</key><string>u</string></dict>
<dict><key>term</key><string>ai chat</string><key>url</key><string>u</string></dict>
</array></dict></plist>`;

test('parseHints: ordine, decodare entitati, litere mici, fara dubluri', () => {
  assert.deepEqual(parseHints(HINTS), ['ai chat', 'tom & jerry']);
  assert.deepEqual(parseHints('<plist><dict><key>hints</key><array></array></dict></plist>'), []);
});

test('parseSearch: gen principal si subgen de joc', () => {
  const r = parseSearch({ results: [
    { trackId: 1, trackName: 'X', primaryGenreId: 6014, genreIds: ['6014', '7012', '6016'], userRatingCount: 5, averageUserRating: 4.5, releaseDate: '2026-09-01T07:00:00Z' },
    { trackId: 2, trackName: 'Y', primaryGenreId: '6003', genreIds: ['6003'] },
  ] });
  assert.deepEqual(r, [
    { id: 1, name: 'X', seller: '', genreId: 6014, subgenreId: 7012, ratings: 5, stars: 4.5, releaseDate: '2026-09-01', updated: null },
    { id: 2, name: 'Y', seller: '', genreId: 6003, subgenreId: null, ratings: 0, stars: null, releaseDate: null, updated: null },
  ]);
});

test('parseChart: lista, intrare unica si feed gol', () => {
  const entry = (id) => ({ id: { attributes: { 'im:id': String(id) } }, 'im:name': { label: `A${id}` },
    category: { attributes: { 'im:id': '6008' } } });
  assert.deepEqual(parseChart({ feed: { entry: [entry(5), entry(7)] } }).map((x) => [x.rank, x.id]), [[1, 5], [2, 7]]);
  assert.equal(parseChart({ feed: { entry: entry(9) } })[0].genreId, 6008);
  assert.deepEqual(parseChart({ feed: {} }), []);
});

test('throttle: o eroare nu blocheaza apelurile urmatoare', async () => {
  const t = makeThrottle(0);
  await assert.rejects(t(async () => { throw new Error('x'); }));
  assert.equal(await t(async () => 42), 42);
});

test('retry: reincearca la 429, nu la 404', async () => {
  const sleeps = [];
  const retry = makeRetry({ retries: 3, baseDelayMs: 10, sleep: async (ms) => sleeps.push(ms) });
  let n = 0;
  assert.equal(await retry(async () => { if (++n < 3) throw new HttpError(429, 't'); return 'ok'; }), 'ok');
  assert.deepEqual(sleeps, [10, 20]);
  let m = 0;
  await assert.rejects(retry(async () => { m++; throw new HttpError(404, 't'); }));
  assert.equal(m, 1);
});

test('counter: tooManyFailures peste 10% dupa minim 50 cereri', async () => {
  const c = makeCounter();
  for (let i = 0; i < 44; i++) await c.track(async () => 1);
  for (let i = 0; i < 6; i++) await c.track(async () => { throw new Error('x'); }).catch(() => {});
  assert.equal(c.tooManyFailures(), true); // 6/50 = 12%
  assert.equal(makeCounter().tooManyFailures(), false);
});

test('client.suggest trimite storefront-ul tarii', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, text: async () => HINTS }; };
  const apple = makeAppleClient({ fetchImpl, lightMs: 0, retry: makeRetry({ retries: 0 }) });
  assert.deepEqual(await apple.suggest('ai', 'DE'), ['ai chat', 'tom & jerry']);
  assert.equal(seen.opts.headers['X-Apple-Store-Front'], '143443,29');
  assert.match(seen.url, /term=ai$/);
  assert.equal(apple.counter.stats.requests, 1);
});

test('parseSubtitle: primul subtitlu din pagina (antetul app-ului)', async () => {
  const { parseSubtitle } = await import('../src/apple/clients.js');
  const html = '<h1>X</h1><h2 class="subtitle svelte-kps97o">Explore, build &amp; craft</h2><p class="subtitle svelte-1">Altceva</p>';
  assert.equal(parseSubtitle(html), 'Explore, build & craft');
  assert.equal(parseSubtitle('<html></html>'), null);
});

test('parseAppMeta: date stabile + cifrele zilei', () => {
  const [m] = parseAppMeta({ results: [{ trackId: 7, trackName: 'A', primaryGenreId: 6014, releaseDate: '2026-10-01T07:00:00Z',
    sellerName: 'S', userRatingCount: 120, userRatingCountForCurrentVersion: 30, averageUserRating: 4.6789,
    version: '1.2', currentVersionReleaseDate: '2026-10-15T10:00:00Z', price: 2.99, releaseNotes: 'Bug fixes' }] });
  assert.deepEqual(m, { id: 7, name: 'A', genreId: 6014, releaseDate: '2026-10-01', seller: 'S',
    ratings: 120, ratingsCur: 30, stars: 4.68, version: '1.2', updated: '2026-10-15', price: 2.99, notes: 'Bug fixes' });
});

test('parseIap / parseSimilar: din pagina web App Store', () => {
  const html = `"hasInAppPurchases":true <ul><li><div class="text-pair svelte-1"><span>Premium &amp; More</span> <span>9,99\u00a0€</span> </div></li>
    <li><div class="text-pair svelte-1"><span>Coins</span> <span>$1.99</span> </div></li></ul>
    <section id="similarItems" data-test-id="shelf-wrapper"><a href="https://apps.apple.com/us/app/x/id11">x</a>
    <a href="https://apps.apple.com/us/app/y/id5">self</a><a href="https://apps.apple.com/us/app/x/id11">x</a><a href="/us/app/z/id12">z</a></section>
    <section data-test-id="shelf-wrapper"><a href="https://apps.apple.com/us/app/w/id99">alt raft</a></section>`;
  assert.deepEqual(parseIap(html), { has: true, items: [{ name: 'Premium & More', price: '9,99 €' }, { name: 'Coins', price: '$1.99' }] });
  assert.deepEqual(parseIap('<html></html>'), { has: false, items: [] });
  assert.deepEqual(parseSimilar(html, 5), [11, 12]);
  assert.deepEqual(parseSimilar('<html></html>', 5), []);
});

test('parseReviews: stele, text, versiune', () => {
  const e = (n) => ({ id: { label: `r${n}` }, 'im:rating': { label: String(n) }, title: { label: `T${n}` }, content: { label: 'txt' },
    'im:version': { label: '1.0' }, updated: { label: '2026-10-19T02:43:53-07:00' } });
  assert.deepEqual(parseReviews({ feed: { entry: [e(1), e(5)] } }).map((r) => [r.stars, r.title, r.date]), [[1, 'T1', '2026-10-19'], [5, 'T5', '2026-10-19']]);
  assert.deepEqual(parseReviews({ feed: { entry: e(3) } }).length, 1);
  assert.deepEqual(parseReviews({ feed: {} }), []);
});

test('cautarile din mai multe tari impart acelasi ritm (Apple limiteaza pe adresa, nu pe tara)', async () => {
  const at = [];
  let t = 0;
  const sleep = async (ms) => { t += ms; };
  const now = () => t;
  const fetchImpl = async (url) => {
    if (url.includes('/search?')) at.push(t);
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const searchThrottle = makeThrottle(3000, { sleep, now });
  const opts = { fetchImpl, searchThrottle, retry: makeRetry({ retries: 0 }) };
  const us = makeAppleClient(opts);
  const de = makeAppleClient(opts);
  await Promise.all([us.topApps('a', 'US'), de.topApps('b', 'DE'), us.upcoming('c', 'US', '2026-11-09'), de.topApps('d', 'DE')]);
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 3000, `pauza ${at[i] - at[i - 1]} ms intre cautari`);
});
