// Verificarea zilei inainte de calcul (din convex/collect.js, cand toate benzile au terminat). O banda cu lipsuri
// (laneProblems in worker.js; ex. 13 si 15 nov 2026: Apple a refuzat topurile cateva minute, banda de app-uri s-a
// oprit, iar topurile, app-urile noi si rating-urile zilei s-au pierdut in 5-6 tari) se reia de la capat dupa
// RETRY_WAIT_MS, de cel mult MAX_LANE_RETRIES ori. Dintre incercari ramane cea mai buna (laneScore).
// `ctx` e cel al unei mutatii Convex (db.patch, storage.delete); `jobs` = randurile tabelei jobs ale zilei.
import { newJob, laneProblems, laneScore } from './worker.js';

export const MAX_LANE_RETRIES = 2;
export const RETRY_WAIT_MS = 10 * 60_000;
const now8 = () => new Date().toISOString().slice(11, 19);
export const noPrev = ({ prev, ...job }) => job;

export async function checkLanes(ctx, jobs, log) {
  const t = Date.now();
  let retried = 0;
  const countries = {};
  for (const row of jobs) {
    let { job, parts } = row;
    const prev = job.prev;
    if (prev) {
      const keepPrev = laneScore(prev.job) > laneScore(job);
      const lose = keepPrev ? parts : prev.parts;
      for (const p of lose) await ctx.storage.delete(p.storageId);
      if (keepPrev) ({ job, parts } = { job: { ...prev.job, retries: job.retries }, parts: prev.parts });
      else job = noPrev(job);
      if (keepPrev) log.push(`${now8()} [${row.country}] ${job.lane}: incercarea anterioara a cules mai mult, o pastrez`);
    }
    const problems = laneProblems(job);
    const retries = job.retries ?? 0;
    if (problems.length && retries < MAX_LANE_RETRIES) {
      if (row.prepId) await ctx.storage.delete(row.prepId);
      const fresh = { ...newJob(row.country, row.date, job.lane), searchUntil: job.searchUntil, retries: retries + 1,
        waitUntil: t + RETRY_WAIT_MS, prev: { job: noPrev(job), parts } };
      await ctx.db.patch(row._id, { job: fresh, parts: [], prepId: undefined });
      log.push(`${now8()} [${row.country}] ${job.lane}: ${problems.join('; ')} -> reiau banda peste ${RETRY_WAIT_MS / 60_000} min (incercarea ${retries + 2})`);
      retried++;
      continue;
    }
    if (job !== row.job || parts !== row.parts) await ctx.db.patch(row._id, { job, parts });
    const c = (countries[row.country] ??= { problems: [], retries: 0 });
    c.problems.push(...problems.map((p) => `${job.lane === 'apps' ? 'app-uri' : 'cuvinte'}: ${p}`));
    c.retries += retries;
    if (job.blocked?.length) c.blocked = [...(c.blocked ?? []), ...job.blocked];
    c[job.lane ?? 'all'] = job.summary ?? {};
  }
  return { retried, quality: { at: t, countries } };
}
