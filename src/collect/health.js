// Verificarea zilnica a zilei (convex/health.js, din cron): s-a colectat, s-a calculat, s-a publicat, e completa?
// `bad` = date pierdute sau zi negata (merita o alerta); `info` = de stiut, nimic pierdut definitiv.
// run: randul din tabela runs (sau null); gen: generatia publicata pe site (ex. '2026-11-21T05-08-36-930Z');
// final: ultima verificare a zilei (atunci o zi neterminata e problema, nu "inca ruleaza").
export const LATE_AFTER_MS = 6 * 3600_000;
const NAMES = { classify: 'clasificarea cuvintelor', upcoming: 'precomenzile' };

export function evaluateDay({ date, run, gen, now = Date.now(), final = false }) {
  const issues = [];
  const bad = (text) => issues.push({ level: 'bad', text });
  const info = (text) => issues.push({ level: 'info', text });
  if (!run) bad(`Colectarea de azi (${date}) n-a pornit.`);
  else if (run.status === 'failed') bad(`Ziua ${date} a eșuat: ${run.error ?? 'eroare necunoscută'}.`);
  else if (run.status !== 'done') {
    const h = Math.round((now - run.startedAt) / 360_000) / 10;
    const what = run.status === 'collecting' ? 'colectarea' : 'calculul';
    if (final || now - run.startedAt > LATE_AFTER_MS) bad(`Ziua ${date} încă nu e gata după ${h} h (${what} în lucru).`);
    else info(`Ziua ${date} încă rulează (${what}, de ${h} h).`);
  } else if (!gen?.startsWith(date)) bad(`Ziua ${date} s-a calculat, dar nu apare pe site (pe site e ${gen?.slice(0, 10) ?? 'nimic'}).`);

  const countries = run?.quality?.countries ?? {};
  for (const [cc, c] of Object.entries(countries)) {
    if (c.problems?.length) bad(`${cc}: ${c.problems.join('; ')}${c.retries ? ` (după ${c.retries} ${c.retries === 1 ? 'reluare' : 'reluări'})` : ''}.`);
  }
  const blocked = {};
  for (const [cc, c] of Object.entries(countries)) for (const p of new Set(c.blocked ?? [])) (blocked[p] ??= []).push(cc);
  for (const [p, ccs] of Object.entries(blocked)) {
    info(`Apple a blocat căutarea: ${NAMES[p] ?? p} lipsește azi în ${ccs.join(', ')}${p === 'classify' ? ' (continuă mâine)' : ''}.`);
  }
  const repaired = Object.entries(countries).filter(([, c]) => c.retries && !c.problems?.length).map(([cc]) => cc);
  if (repaired.length) info(`Reparat automat (reluat după erori Apple): ${repaired.join(', ')}.`);
  return { date, at: now, ok: !issues.some((i) => i.level === 'bad'), issues };
}

// Textul notificarii (telefon): doar problemele, pe scurt.
export function alertText(h) {
  return h.issues.filter((i) => i.level === 'bad').map((i) => `• ${i.text}`).join('\n');
}
