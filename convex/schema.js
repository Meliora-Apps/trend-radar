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
  // Stari cu un singur rand: 'current' (generatia exportului), 'db/<CC>' (baza de calcul a unei tari, in bucati
  // gzip; 'db' = vechea baza cu toate tarile, stearsa la primul calcul pe tari), 'plan/<CC>' (planul colectarii
  // urmatoare), 'cloud' (starea ultimei colectari, pentru interfata).
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
  }).index('by_kind_date_country', ['kind', 'date', 'country']).index('by_date', ['date']).index('by_country', ['country']),
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
    pace: v.optional(v.any()), // ritmul cererilor Apple atins de ultima bucata (vezi PACE in collect.js)
    // Refuzurile (403) la rand la cautare, in toate tarile, si ora ultimului (SEARCH_BLOCKED_SHARED in worker.js).
    searchGate: v.optional(v.object({ denied: v.number(), at: v.optional(v.number()) })),
    log: v.array(v.string()),
  }).index('by_date', ['date']).index('by_status', ['status']),
  // Calculul unei zile, pe pasi (vezi convex/calc.js si convex/process.js): pasii tarilor, apoi pasii comuni.
  // steps: { [nume]: { stage: 'country' | 'merge', status: waiting | running | done | failed, attempts, lease, ... } }
  calcs: defineTable({
    date: v.string(),
    token: v.string(),
    gen: v.string(),
    status: v.string(), // running | done | failed
    startedAt: v.number(),
    updatedAt: v.optional(v.number()), // ultima miscare (un pas inceput sau terminat)
    finishedAt: v.optional(v.number()),
    expect: v.number(), // cate fisiere trebuie sa aiba generatia publicata
    steps: v.any(),
    error: v.optional(v.string()),
  }).index('by_token', ['token']).index('by_status', ['status']).index('by_date', ['date']),
  // Bucatile intermediare ale unui calcul (src/export/split.js): ce lasa pasul unei tari pentru pasii comuni.
  pieces: defineTable({ token: v.string(), key: v.string(), storageId: v.id('_storage') })
    .index('by_token_key', ['token', 'key']),
  // Starea colectarii fiecarei tari intr-o zi (vezi src/collect/worker.js) + bucatile culese (fisiere JSON).
  // O tara are doua randuri, cate unul pe banda (job.lane: words / apps), care lucreaza in paralel.
  jobs: defineTable({
    date: v.string(),
    country: v.string(),
    job: v.any(),
    prepId: v.optional(v.id('_storage')),
    parts: v.array(v.object({ phase: v.string(), storageId: v.id('_storage') })),
  }).index('by_date_country', ['date', 'country']),
  // Ultima verificare "Verifica acum" a unui app intr-o tara: locul real in cautare (top 200) la fiecare cuvant.
  appChecks: defineTable({
    appId: v.number(),
    country: v.string(),
    at: v.number(),
    results: v.array(v.object({ term: v.string(), position: v.union(v.number(), v.null()), total: v.number() })),
  }).index('by_app_country', ['appId', 'country']),
});
