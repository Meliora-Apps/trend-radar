// Verificarea zilei inainte de calcul (checkLanes din convex/collect.js), cu un ctx Convex de proba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLanes, MAX_LANE_RETRIES } from '../src/collect/check.js';

function fakeCtx(rows) {
  const deleted = [];
  const byId = new Map(rows.map((r) => [r._id, r]));
  return {
    deleted,
    rows: byId,
    storage: { delete: async (id) => { deleted.push(id); } },
    db: { patch: async (id, patch) => { const r = byId.get(id); for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete r[k]; else r[k] = v; } } },
  };
}
const good = { lane: 'apps', phase: 'done', summary: { charts: { n: 120, ok: 120 }, feed: { n: 2, ok: 2 }, lookup: { n: 230, ok: 230 } } };
const broken = { lane: 'apps', phase: 'done', aborted: true, summary: { charts: { n: 120, ok: 50 } } };
const words = { lane: 'words', phase: 'done', keywordsOk: true, summary: { base: { n: 700, ok: 700 }, expand: { n: 1000, ok: 990 } } };
const row = (id, country, job, parts = [{ phase: 'charts', storageId: `${id}-p` }]) => ({ _id: id, country, date: '2026-11-13', job, parts });

test('checkLanes: o zi buna trece la calcul, cu calitatea pe tari', async () => {
  const ctx = fakeCtx([row('a', 'US', good), row('w', 'US', words)]);
  const log = [];
  const r = await checkLanes(ctx, [...ctx.rows.values()], log);
  assert.equal(r.retried, 0);
  assert.deepEqual(r.quality.countries.US.problems, []);
  assert.equal(ctx.deleted.length, 0);
});

test('checkLanes: banda de app-uri oprita (13 nov) se reia dupa o pauza, cu incercarea veche pastrata', async () => {
  const ctx = fakeCtx([row('a', 'DE', broken), row('w', 'DE', words)]);
  const log = [];
  const r = await checkLanes(ctx, [...ctx.rows.values()], log);
  assert.equal(r.retried, 1);
  const j = ctx.rows.get('a');
  assert.equal(j.job.phase, 'charts');
  assert.equal(j.job.retries, 1);
  assert.ok(j.job.waitUntil > Date.now());
  assert.deepEqual(j.parts, []);
  assert.deepEqual(j.job.prev.parts, [{ phase: 'charts', storageId: 'a-p' }]);
  assert.equal(ctx.deleted.length, 0, 'incercarea veche nu se sterge inca');
  assert.match(log[0], /\[DE\] apps: oprita.*reiau banda/);

  // Reluarea a mers: ramane ea, cea veche se sterge.
  j.job = { ...good, retries: 1, prev: j.job.prev };
  j.parts = [{ phase: 'charts', storageId: 'a-new' }];
  const r2 = await checkLanes(ctx, [...ctx.rows.values()], []);
  assert.equal(r2.retried, 0);
  assert.deepEqual(ctx.deleted, ['a-p']);
  assert.equal(j.job.prev, undefined);
  assert.deepEqual(r2.quality.countries.DE.problems, []);
  assert.equal(r2.quality.countries.DE.retries, 1);
});

test('checkLanes: dupa MAX_LANE_RETRIES ramane cea mai buna incercare, iar problema intra in calitatea zilei', async () => {
  const better = { ...broken, summary: { charts: { n: 120, ok: 90 } } };
  const ctx = fakeCtx([row('a', 'FR', { ...broken, retries: MAX_LANE_RETRIES, prev: { job: better, parts: [{ phase: 'charts', storageId: 'old' }] } }, [{ phase: 'charts', storageId: 'new' }])]);
  const log = [];
  const r = await checkLanes(ctx, [...ctx.rows.values()], log);
  assert.equal(r.retried, 0);
  assert.deepEqual(ctx.deleted, ['new']);
  const j = ctx.rows.get('a');
  assert.deepEqual(j.parts, [{ phase: 'charts', storageId: 'old' }]);
  assert.equal(j.job.summary.charts.ok, 90);
  assert.ok(r.quality.countries.FR.problems.some((p) => p.startsWith('app-uri: oprita')));
  assert.match(log[0], /pastrez/);
});
