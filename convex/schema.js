import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { authTables } from '@convex-dev/auth/server';

export default defineSchema({
  ...authTables,
  // Doar aceste emailuri intra (logare Google). Se adauga cu: npx convex run admin:allow '{"email":"..."}'
  allowed: defineTable({ email: v.string() }).index('by_email', ['email']),
  // Fisierele exportului zilnic (vezi src/export/build.js). `gen` = generatia; doar cea curenta e citita.
  files: defineTable({ gen: v.string(), key: v.string(), storageId: v.id('_storage') })
    .index('by_gen_key', ['gen', 'key']),
  // Generatia curenta (o singura inregistrare, name='current').
  state: defineTable({ name: v.string(), gen: v.string(), at: v.string() }).index('by_name', ['name']),
});
