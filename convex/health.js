// Verificarea zilnica (cron, de doua ori pe zi): ziua s-a colectat, calculat, publicat si e completa?
// Rezultatul ramane in state/health (il arata site-ul, vezi data.me) si, la probleme, pleaca o notificare pe telefon
// prin ntfy (https://ntfy.sh), daca e setat ALERT_NTFY_TOPIC (numele secret al canalului, din aplicatia ntfy).
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { evaluateDay, alertText } from '../src/collect/health.js';
import { todayUTC } from '../src/util/dates.js';

const stateOf = (ctx, name) => ctx.db.query('state').withIndex('by_name', (q) => q.eq('name', name)).unique();

export const snapshot = internalQuery({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const run = await ctx.db.query('runs').withIndex('by_date', (q) => q.eq('date', date)).unique();
    const { log, ...light } = run ?? {};
    return { run: run ? light : null, gen: (await stateOf(ctx, 'current'))?.gen ?? null, prev: (await stateOf(ctx, 'health'))?.value ?? null };
  },
});

export const save = internalMutation({
  args: { health: v.any() },
  handler: async (ctx, { health }) => {
    const row = await stateOf(ctx, 'health');
    const at = new Date(health.at).toISOString();
    if (row) await ctx.db.patch(row._id, { value: health, at }); else await ctx.db.insert('state', { name: 'health', value: health, at });
  },
});

// Publicarea JSON a ntfy (accepta diacritice in titlu; antetele HTTP nu). O notificare care nu pleaca nu opreste
// verificarea: problema ramane oricum pe site.
async function notify(title, message, { priority = 4, tags = ['warning'] } = {}) {
  const topic = process.env.ALERT_NTFY_TOPIC;
  if (!topic) return 'fara ALERT_NTFY_TOPIC: notificarea nu pleaca';
  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, priority, tags, click: 'https://trend-radar.meliorapps.uk' }),
    });
    return res.ok ? 'notificare trimisa' : `ntfy a raspuns HTTP ${res.status}`;
  } catch (err) {
    return `notificarea n-a plecat: ${err.message}`;
  }
}

// npx convex run --prod health:check '{"final":true}'   (implicit: ziua de azi, UTC)
export const check = internalAction({
  args: { date: v.optional(v.string()), final: v.optional(v.boolean()) },
  handler: async (ctx, { date = todayUTC(), final = false }) => {
    const { run, gen, prev } = await ctx.runQuery(internal.health.snapshot, { date });
    const h = evaluateDay({ date, run, gen, final });
    await ctx.runMutation(internal.health.save, { health: h });
    let sent = '';
    if (!h.ok) sent = await notify(`Trend Radar: problemă cu ziua ${date}`, alertText(h));
    else if (prev && prev.date === date && !prev.ok) sent = await notify(`Trend Radar: ziua ${date} e în regulă acum`, 'Problema de mai devreme s-a rezolvat.', { priority: 3, tags: ['white_check_mark'] });
    console.log(JSON.stringify(h), sent);
    return { ...h, sent };
  },
});

// Proba canalului: npx convex run --prod health:test
export const test = internalAction({
  args: {},
  handler: () => notify('Trend Radar: probă', 'Dacă vezi asta, alertele ajung la tine.', { priority: 3, tags: ['bell'] }),
});
