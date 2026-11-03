import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { auth } from './auth';

const http = httpRouter();
auth.addHttpRoutes(http);

// Incarcarea manuala a fisierelor zilnice (src/export/upload.js: mutarea istoricului, sau o zi colectata
// de pe alt calculator), cu cheia secreta INGEST_SECRET (setata doar in Convex si local; nu e in depozit).
function authorized(req) {
  const secret = process.env.INGEST_SECRET;
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
}
const KINDS = new Set(['days', 'classify', 'apps', 'stats', 'changes']);

// Ce e deja in arhiva: [{ kind, date, country, size }].
http.route({
  path: '/ingest/raw-list',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const rows = [];
    let cursor = null;
    do {
      const page = await ctx.runQuery(internal.store.rawPage, { cursor });
      rows.push(...page.rows.map(({ kind, date, country, size }) => ({ kind, date, country, size })));
      cursor = page.cursor;
    } while (cursor);
    return Response.json(rows);
  }),
});

http.route({
  path: '/ingest/raw',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const q = new URL(req.url).searchParams;
    const kind = q.get('kind');
    const date = q.get('date');
    const country = q.get('country');
    if (!KINDS.has(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^[A-Z]{2}$/.test(country ?? '')) {
      return new Response('kind/date/country gresite', { status: 400 });
    }
    const blob = await req.blob();
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.store.saveRaw, { kind, date, country, storageId, size: blob.size });
    return new Response('ok');
  }),
});

// Recalculeaza baza si exportul (dupa o incarcare).
http.route({
  path: '/ingest/process',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const { date } = await req.json();
    await ctx.scheduler.runAfter(0, internal.process.run, { date });
    return Response.json({ scheduled: date });
  }),
});

export default http;
