// Verificarea la fiecare cerere: logat SI inca pe lista (scos de pe lista = pierde accesul imediat).
import { getAuthUserId } from '@convex-dev/auth/server';
import { ConvexError } from 'convex/values';

export async function allowedEmail(ctx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  const email = user?.email?.toLowerCase();
  if (!email) return null;
  const row = await ctx.db.query('allowed').withIndex('by_email', (q) => q.eq('email', email)).unique();
  return row ? email : null;
}

export async function requireAllowed(ctx) {
  const email = await allowedEmail(ctx);
  if (!email) throw new ConvexError('NOT_ALLOWED');
  return email;
}
