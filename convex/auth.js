import Google from '@auth/core/providers/google';
import { convexAuth } from '@convex-dev/auth/server';
import { ConvexCredentials } from '@convex-dev/auth/providers/ConvexCredentials';
import { internal } from './_generated/api';

const norm = (e) => String(e ?? '').trim().toLowerCase();

// Doar pentru teste pe un Convex local: logare fara Google, cu DEV_LOGIN_SECRET (niciodata setat in productie).
const devLogin = process.env.DEV_LOGIN_SECRET ? [ConvexCredentials({
  id: 'dev',
  authorize: async ({ email, secret }, ctx) => {
    if (secret !== process.env.DEV_LOGIN_SECRET) return null;
    const userId = await ctx.runMutation(internal.admin.devUser, { email: String(email) });
    return userId ? { userId } : null;
  },
})] : [];

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, ...devLogin],
  callbacks: {
    // Logarea merge doar pentru emailurile din tabela `allowed` (verificate de Google).
    async createOrUpdateUser(ctx, { existingUserId, profile }) {
      const email = norm(profile.email);
      const ok = email && profile.emailVerified !== false
        && await ctx.db.query('allowed').withIndex('by_email', (q) => q.eq('email', email)).unique();
      if (!ok) throw new Error('NOT_ALLOWED');
      if (existingUserId) return existingUserId;
      const user = await ctx.db.query('users').withIndex('email', (q) => q.eq('email', email)).unique();
      if (user) return user._id;
      return ctx.db.insert('users', { email, name: profile.name ?? undefined, image: profile.image ?? undefined, emailVerificationTime: Date.now() });
    },
  },
});
