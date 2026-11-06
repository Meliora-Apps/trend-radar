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

// Calculul facut pe alt calculator (src/export/remote-calc.js): copia bazei de calcul, apoi fisierele exportului.
http.route({
  path: '/ingest/db',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const db = await ctx.runQuery(internal.store.getState, { name: 'db' });
    const cloud = await ctx.runQuery(internal.store.getState, { name: 'cloud' });
    const urls = [];
    for (const id of db?.storageIds ?? []) urls.push(await ctx.storage.getUrl(id));
    return Response.json({ at: db?.at ?? null, urls, cloud: cloud?.value ?? null });
  }),
});

http.route({
  path: '/ingest/file',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const q = new URL(req.url).searchParams;
    const gen = q.get('gen');
    const key = q.get('key');
    if (!/^[\dT-]+Z$/.test(gen ?? '') || !/^[\w/.-]+$/.test(key ?? '')) return new Response('gen/key gresite', { status: 400 });
    const storageId = await ctx.storage.store(await req.blob());
    await ctx.runMutation(internal.data.addFiles, { gen, files: [{ key, storageId }] });
    return new Response('ok');
  }),
});

// Un fisier zilnic din arhiva (adresa de descarcare).
http.route({
  path: '/ingest/raw-get',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const q = new URL(req.url).searchParams;
    const r = await ctx.runQuery(internal.store.rawOf, { kind: q.get('kind') ?? '', date: q.get('date') ?? '', country: q.get('country') ?? '' });
    if (!r) return new Response('lipseste', { status: 404 });
    return Response.json({ url: await ctx.storage.getUrl(r.storageId), size: r.size });
  }),
});

// Un fisier oarecare (bucatile bazei, planurile): intoarce id-ul lui, pentru /ingest/state.
http.route({
  path: '/ingest/blob',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    return Response.json({ storageId: await ctx.storage.store(await req.blob()) });
  }),
});

// Inlocuieste o stare: baza de calcul ('db'), planul de maine ('plan/<CC>') sau starea colectarii ('cloud').
http.route({
  path: '/ingest/state',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const { name, storageIds, value } = await req.json();
    if (!/^(db|cloud|plan\/[A-Z]{2})$/.test(name ?? '')) return new Response('stare necunoscuta', { status: 400 });
    await ctx.runMutation(internal.store.setState, { name, storageIds, value });
    return new Response('ok');
  }),
});

http.route({
  path: '/ingest/commit',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const { gen } = await req.json();
    return Response.json({ files: await ctx.runMutation(internal.data.commit, { gen }) });
  }),
});

export default http;
