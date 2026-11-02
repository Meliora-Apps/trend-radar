// Lista de acces. Doar din terminal (functii interne): npx convex run admin:allow '{"email":"x@gmail.com"}'
import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

const norm = (e) => e.trim().toLowerCase();

export const allow = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const e = norm(email);
    const row = await ctx.db.query('allowed').withIndex('by_email', (q) => q.eq('email', e)).unique();
    if (!row) await ctx.db.insert('allowed', { email: e });
    return `${e}: are acces`;
  },
});

export const revoke = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const e = norm(email);
    const row = await ctx.db.query('allowed').withIndex('by_email', (q) => q.eq('email', e)).unique();
    if (row) await ctx.db.delete(row._id);
    // Sesiunile deschise se inchid: urmatoarea cerere a lui e refuzata oricum (requireAllowed).
    return `${e}: acces scos`;
  },
});

export const list = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query('allowed').collect()).map((r) => r.email),
});

// Pentru logarea de test (auth.js, DEV_LOGIN_SECRET): utilizatorul, doar daca emailul e pe lista.
export const devUser = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const e = norm(email);
    if (!await ctx.db.query('allowed').withIndex('by_email', (q) => q.eq('email', e)).unique()) return null;
    const user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', e)).unique();
    return user?._id ?? ctx.db.insert('users', { email: e });
  },
});
