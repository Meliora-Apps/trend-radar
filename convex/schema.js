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
  // Stari cu un singur rand: 'current' (generatia exportului), 'db' (baza de calcul, in bucati gzip),
  // 'plan/<CC>' (planul colectarii urmatoare), 'cloud' (starea ultimei colectari, pentru interfata).
  state: defineTable({
    name: v.string(),
    gen: v.optional(v.string()),
    at: v.string(),
    storageIds: v.optional(v.array(v.id('_storage'))),
    value: v.optional(v.any()),
  }).index('by_name', ['name']),
  // Arhiva completa a datelor: fisierele zilnice (days/classify/apps/stats/changes), ca in data/ din depozit.
  raw: defineTable({
    kind: v.string(), date: v.string(), country: v.string(), storageId: v.id('_storage'), size: v.number(),
  }).index('by_kind_date_country', ['kind', 'date', 'country']).index('by_date', ['date']),
  // O zi de colectare: starea generala (lease = cine lucreaza acum, pana cand).
  runs: defineTable({
    date: v.string(),
    status: v.string(), // collecting | processing | done | failed
    startedAt: v.number(),
    lease: v.number(),
    ticks: v.number(),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),
    log: v.array(v.string()),
  }).index('by_date', ['date']).index('by_status', ['status']),
  // Starea colectarii fiecarei tari intr-o zi (vezi src/collect/worker.js) + bucatile culese (fisiere JSON).
  jobs: defineTable({
    date: v.string(),
    country: v.string(),
    job: v.any(),
    prepId: v.optional(v.id('_storage')),
    parts: v.array(v.object({ phase: v.string(), storageId: v.id('_storage') })),
  }).index('by_date_country', ['date', 'country']),
});
