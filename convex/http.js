import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { auth } from './auth';

const http = httpRouter();
auth.addHttpRoutes(http);

// Exportul zilnic din GitHub Actions trimite fisierele aici, cu cheia secreta INGEST_SECRET
// (setata in Convex si in secretele GitHub; nu e in depozit).
function authorized(req) {
  const secret = process.env.INGEST_SECRET;
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
}

http.route({
  path: '/ingest/file',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const url = new URL(req.url);
    const gen = url.searchParams.get('gen');
    const key = url.searchParams.get('key');
    if (!gen || !key) return new Response('gen/key lipsa', { status: 400 });
    const storageId = await ctx.storage.store(await req.blob());
    await ctx.runMutation(internal.data.addFile, { gen, key, storageId });
    return new Response('ok');
  }),
});

http.route({
  path: '/ingest/commit',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const { gen, expected } = await req.json();
    const n = await ctx.runMutation(internal.data.commit, { gen, expected });
    return Response.json({ gen, files: n });
  }),
});

export default http;
