import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHints, parseSearch, parseChart, parseAppMeta, parseIap, parseSimilar, parseReviews, makeAppleClient } from '../src/apple/clients.js';
import { makeThrottle, makeRetry, makeCounter, makePacer, HttpError, OutOfTime } from '../src/apple/net.js';

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

// Un ceas de proba: sleep avanseaza timpul, fara asteptari reale.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('pacer: cererile pornesc la interval, chiar daca sunt simultane; 429 = pauza comuna si ritm mai rar', async () => {
  const slept = [];
  const p0 = makePacer(100, { now: () => 0, sleep: async (ms) => { slept.push(ms); } });
  await Promise.all([p0.wait(), p0.wait(), p0.wait()]);
  assert.deepEqual(slept, [100, 200], 'pornesc la 0, 100, 200 fara sa astepte una dupa alta');

  const c = fakeClock();
  const p = makePacer(100, { maxMs: 1000, pauseMs: 5000, ...c });
  await p.wait();
  p.slow();
  assert.deepEqual(p.stats(), { intervalMs: 150, pauses: 1 });
  await p.wait();
  assert.ok(c.now() >= 5000, `dupa pauza (${c.now()})`);
  for (let i = 0; i < 100; i++) p.ok();
  assert.equal(p.stats().intervalMs, 100, 'revine la ritmul de baza');
  for (let i = 0; i < 20; i++) p.slow();
  assert.equal(p.stats().intervalMs, 1000, 'cel mult maxMs');
});

test('client cu pacer comun: 429 incetineste pacerul, reincercarea trece dupa pauza; cererea agatata expira', async () => {
  const c = fakeClock();
  const hints = makePacer(10, { pauseMs: 1000, ...c });
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? { ok: false, status: 429 } : { ok: true, text: async () => HINTS });
  const apple = makeAppleClient({ fetchImpl, pacers: { hints }, retry: makeRetry({ retries: 2, rateLimitDelayMs: 0, sleep: c.sleep }) });
  assert.deepEqual(await apple.suggest('ai', 'US'), ['ai chat', 'tom & jerry']);
  assert.equal(n, 2);
  assert.equal(hints.stats().pauses, 1);
  assert.ok(c.now() >= 1000);

  const hung = makeAppleClient({ fetchImpl: () => new Promise(() => {}), lightMs: 0, timeoutMs: 20, retry: makeRetry({ retries: 0 }) });
  await assert.rejects(hung.suggest('ai', 'US'), /fara raspuns/);
});

test('client: 403 la cautare nu se reincearca, dar incetineste ritmul comun al cautarii (limita Apple pe minut)', async () => {
  let n = 0;
  const apple = makeAppleClient({ fetchImpl: async () => { n++; return { ok: false, status: 403 }; }, searchMs: 0, retry: makeRetry({ retries: 3, baseDelayMs: 1 }) });
  await assert.rejects(apple.topApps('x', 'US'), (e) => e.status === 403);
  assert.equal(n, 1);

  const c = fakeClock();
  const search = makePacer(100, { pauseMs: 1000, ...c });
  const lookup = makePacer(100, { pauseMs: 1000, ...c });
  const paced = makeAppleClient({ fetchImpl: async () => ({ ok: false, status: 403 }), pacers: { search, lookup }, retry: makeRetry({ retries: 3, baseDelayMs: 1, sleep: c.sleep }) });
  await assert.rejects(paced.topApps('x', 'US'), (e) => e.status === 403);
  assert.deepEqual(search.stats(), { intervalMs: 150, pauses: 1 });
  // In afara cautarii, un 403 nu e limita de ritm.
  await assert.rejects(paced.appMeta([1], 'US'), (e) => e.status === 403);
  assert.deepEqual(lookup.stats(), { intervalMs: 100, pauses: 0 });
});

test('pacer cu until: cererea care ar porni dupa sfarsitul bucatii iese imediat, fara reincercare si fara sa fie numarata', async () => {
  const c = fakeClock();
  const p = makePacer(1000, { until: 2500, ...c });
  await Promise.all([p.wait(), p.wait(), p.wait()]); // pornesc la 0, 1000, 2000
  await assert.rejects(p.wait(), (e) => e instanceof OutOfTime && e.outOfTime);
  assert.equal(c.now(), 2000, 'nu asteapta degeaba pana dupa sfarsitul bucatii');

  let n = 0;
  const search = makePacer(1000, { until: 0, ...c });
  const apple = makeAppleClient({ fetchImpl: async () => { n++; return { ok: true, json: async () => ({ results: [] }) }; }, pacers: { search }, retry: makeRetry({ retries: 3, baseDelayMs: 1, sleep: c.sleep }) });
  await assert.rejects(apple.topApps('x', 'US'), (e) => e.outOfTime);
  assert.equal(n, 0, 'cererea nu pleaca');
  assert.deepEqual(apple.counter.stats, { requests: 0, failures: 0 });
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

test('client.searchRank: locul app-ului in primele 200, null daca lipseste', async () => {
  let seen;
  const fetchImpl = async (url) => { seen = url; return { ok: true, json: async () => ({ results: [{ trackId: 5 }, { trackId: 9 }, { trackId: 7 }] }) }; };
  const apple = makeAppleClient({ fetchImpl, searchMs: 0, retry: makeRetry({ retries: 0 }) });
  assert.deepEqual(await apple.searchRank('theory test', 'GB', 7), { position: 3, total: 3 });
  assert.deepEqual(await apple.searchRank('theory test', 'GB', '9'), { position: 2, total: 3 });
  assert.deepEqual(await apple.searchRank('x', 'GB', 1), { position: null, total: 3 });
  assert.match(seen, /country=gb&.*limit=200/);
});
