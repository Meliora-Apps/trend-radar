import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
// Colectarea zilnica (ora UTC; in Moldova 05:17 iarna / 06:17 vara). Dureaza ~20-30 min daca Apple raspunde in
// ritmul cerut (vezi PACE in collect.js), apoi calculul pe pasi ~1-2 min (vezi calc.js).
crons.daily('colectare zilnica', { hourUTC: 3, minuteUTC: 17 }, internal.collect.start, {});
// Paznicul: reia o colectare sau un calcul cazut (eroare, timp depasit), si pasii opriti ai unui calcul.
crons.interval('paznic', { minutes: 10 }, internal.collect.watchdog, {});
// Fisierele din storage ramase fara trimitere (o actiune oprita fortat), departe de colectare.
crons.daily('curatenie storage', { hourUTC: 12, minuteUTC: 40 }, internal.store.sweep, {});
export default crons;
