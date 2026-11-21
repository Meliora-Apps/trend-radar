import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDay, alertText } from '../src/collect/health.js';

const date = '2026-11-21';
const start = Date.parse('2026-11-21T03:17:00Z');
const run = (x = {}) => ({ date, status: 'done', startedAt: start, quality: { countries: { US: { problems: [], retries: 0 } } }, ...x });

test('verificarea zilnica: zi buna = ok', () => {
  const h = evaluateDay({ date, run: run(), gen: '2026-11-21T05-08-36-930Z', now: start + 3 * 3600_000 });
  assert.equal(h.ok, true);
  assert.deepEqual(h.issues, []);
});

test('verificarea zilnica: lipsa, esec, nepublicat, intarziere', () => {
  assert.equal(evaluateDay({ date, run: null, gen: null }).ok, false);
  assert.match(evaluateDay({ date, run: run({ status: 'failed', error: 'x' }), gen: null }).issues[0].text, /a eșuat: x/);
  assert.match(evaluateDay({ date, run: run(), gen: '2026-11-20T05-00' }).issues[0].text, /nu apare pe site \(pe site e 2026-11-20\)/);
  const early = evaluateDay({ date, run: run({ status: 'collecting' }), gen: '2026-11-20T05', now: start + 3600_000 });
  assert.equal(early.ok, true);
  assert.equal(early.issues[0].level, 'info');
  assert.equal(evaluateDay({ date, run: run({ status: 'collecting' }), gen: null, now: start + 3600_000, final: true }).ok, false);
  assert.equal(evaluateDay({ date, run: run({ status: 'processing' }), gen: null, now: start + 7 * 3600_000 }).ok, false);
});

test('verificarea zilnica: date pierdute = alerta; cautare blocata si reparat = doar de stiut', () => {
  const q = { countries: {
    DE: { problems: ['app-uri: topurile: 50 din 120'], retries: 2 },
    FR: { problems: [], retries: 1, blocked: ['classify'] },
    IT: { problems: [], retries: 0, blocked: ['classify', 'upcoming'] },
  } };
  const h = evaluateDay({ date, run: run({ quality: q }), gen: '2026-11-21T05' });
  assert.equal(h.ok, false);
  assert.equal(alertText(h), '• DE: app-uri: topurile: 50 din 120 (după 2 reluări).');
  const infos = h.issues.filter((i) => i.level === 'info').map((i) => i.text);
  assert.ok(infos.includes('Apple a blocat căutarea: clasificarea cuvintelor lipsește azi în FR, IT (continuă mâine).'));
  assert.ok(infos.includes('Reparat automat (reluat după erori Apple): FR.'));
});
