import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
// Colectarea zilnica (ora UTC; in Moldova 05:17 iarna / 06:17 vara). Dureaza ~1-3 ore, apoi calculul ~5 min.
crons.daily('colectare zilnica', { hourUTC: 3, minuteUTC: 17 }, internal.collect.start, {});
// Paznicul: reia o colectare sau un calcul cazut (eroare, timp depasit).
crons.interval('paznic', { minutes: 10 }, internal.collect.watchdog, {});
export default crons;
