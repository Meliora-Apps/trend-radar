import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordSource, words } from '../src/metrics/appwords.js';

test('words: litere mici, fara semne, diacritice pastrate', () => {
  assert.deepEqual(words('Minecraft: Play with Friends!'), ['minecraft', 'play', 'with', 'friends']);
  assert.deepEqual(words('Fotobearbeitung & Filter'), ['fotobearbeitung', 'filter']);
});

test('keywordSource: titlu / subtitlu / combinat / partial / ascuns', () => {
  const t = 'Minecraft: Play with Friends', s = 'Explore, build, craft together';
  assert.equal(keywordSource('minecraft', t, s), 'title');
  assert.equal(keywordSource('craft together', t, s), 'subtitle');
  assert.equal(keywordSource('minecraft build', t, s), 'both');
  assert.equal(keywordSource('minecraft pe', t, s), 'partial');
  assert.equal(keywordSource('block games', t, s), 'hidden');
  assert.equal(keywordSource('friend', t, s), 'title'); // singular/plural simplu
  assert.equal(keywordSource('minecraft', t, null), 'title');
});

test('checkCandidates: cunoscute, apoi titlu, subtitlu, sugestii; fara cuvinte de legatura; max', async () => {
  const { checkCandidates } = await import('../src/metrics/appwords.js');
  const c = checkCandidates({
    name: 'Learn UK Driving Theory Test',
    subtitle: 'DVSA car & motorcycle exam',
    known: ['driving theory test', 'theory test'],
    hints: ['driving theory test 2026', 'hazard perception', 'Theory Test', ''],
    max: 40,
  });
  assert.deepEqual(c.slice(0, 2), ['driving theory test', 'theory test']);
  assert.ok(c.includes('learn uk driving theory test'), 'numele intreg');
  assert.ok(c.includes('uk driving'));
  assert.ok(c.includes('driving'));
  assert.ok(c.includes('dvsa car'));
  assert.ok(c.includes('motorcycle exam'));
  assert.ok(c.includes('hazard perception'));
  assert.ok(!c.includes('&'));
  assert.equal(new Set(c).size, c.length, 'fara dubluri');
  assert.ok(c.indexOf('uk driving') < c.indexOf('dvsa car'), 'titlul inaintea subtitlului');
  assert.ok(c.indexOf('motorcycle') < c.indexOf('hazard perception'), 'sugestiile la final');
  assert.equal(checkCandidates({ name: 'A b c d e f g h', subtitle: 'i j k l m n', max: 5 }).length, 5);
});

test('checkCandidates: cuvintele de legatura nu stau singure si nu incep/termina o expresie', async () => {
  const { checkCandidates } = await import('../src/metrics/appwords.js');
  const c = checkCandidates({ name: 'Photo Editor for Instagram', subtitle: 'Edit your pics with filters' });
  assert.ok(!c.includes('for'));
  assert.ok(!c.includes('your'));
  assert.ok(!c.includes('editor for'));
  assert.ok(c.includes('photo editor'));
  assert.ok(c.includes('editor for instagram'));
});

test('checkCandidates: expresiile nu trec peste semne de despartire (& : - , |)', async () => {
  const { checkCandidates } = await import('../src/metrics/appwords.js');
  const c = checkCandidates({ name: 'Learn UK Driving Theory Test', subtitle: 'Mock Tests & Hazard Perception', max: 100 });
  assert.ok(c.includes('mock tests'));
  assert.ok(c.includes('hazard perception'));
  assert.ok(!c.includes('tests hazard'));
  assert.ok(!c.includes('mock tests hazard'));
  const d = checkCandidates({ name: 'Calm: Sleep & Meditation', max: 100 });
  assert.ok(!c.includes('calm sleep') && !d.includes('calm sleep'));
  assert.ok(d.includes('calm') && d.includes('sleep') && d.includes('meditation'));
});

test('hintSeeds: perechi de cuvinte din nume (precise), un singur cuvant doar daca numele are unul', async () => {
  const { hintSeeds } = await import('../src/metrics/appwords.js');
  assert.deepEqual(hintSeeds('Learn UK Driving Theory Test'), ['learn uk', 'uk driving', 'driving theory']);
  assert.deepEqual(hintSeeds('Photo Editor for Instagram'), ['photo editor']);
  assert.deepEqual(hintSeeds('Calm: Sleep & Meditation'), ['calm', 'sleep', 'meditation']);
  assert.deepEqual(hintSeeds('Duolingo'), ['duolingo']);
});

test('hintsFor: doar sugestiile care incep cu perechea ca si cuvinte intregi', async () => {
  const { hintsFor } = await import('../src/metrics/appwords.js');
  assert.deepEqual(hintsFor('learn uk', ['learn ukulele', 'learn uk', 'Learn UK driving', 'learn ukrainian free']), ['learn uk', 'Learn UK driving']);
  assert.deepEqual(hintsFor('uk driving', ['uk driving test', 'uk drivingschool']), ['uk driving test']);
});
