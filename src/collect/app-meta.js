// Lookup zilnic pentru toate app-urile din topuri si din lansarile noi (loturi de 100), scris in data/:
// data/apps, data/stats, data/changes (vezi appFiles in steps.js).
import {
  appsPath, statsPath, changesPath, writeJsonGz, readCountryAppMeta, readCountryNames, readLatestStats,
} from '../data/files.js';
import { LOOKUP_BATCH, STATS_FIELDS, NOTES_MAX, appFiles, lookupIds, grossingIds } from './steps.js';

export { LOOKUP_BATCH, STATS_FIELDS, NOTES_MAX };

export async function collectAppMeta({ country, date, dataDir, apple, charts, extraIds = [], log = console.log, stop = () => false, max = Infinity }) {
  const known = readCountryAppMeta(dataDir, country, { before: date });
  const names = readCountryNames(dataDir, country, { before: date, known });
  const prev = readLatestStats(dataDir, country, { before: date }) ?? {};
  const ids = lookupIds(charts, extraIds, max);
  log(`[${country}] lookup: ${ids.length} app-uri (${ids.filter((id) => !known.has(id)).length} noi)`);
  const results = [];
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    if (stop()) break;
    try {
      results.push(...await apple.appMeta(ids.slice(i, i + LOOKUP_BATCH), country));
    } catch (err) {
      log(`[${country}] lookup app-uri esuat: ${err.message}`);
    }
  }
  const { meta, stats, changes } = appFiles({ date, results, known, names, prev, grossing: grossingIds(charts) });
  // Scrise mereu (si goale), ca artefactul din GitHub sa pastreze structura.
  writeJsonGz(appsPath(dataDir, date, country), meta);
  writeJsonGz(statsPath(dataDir, date, country), stats);
  writeJsonGz(changesPath(dataDir, date, country), changes);
  return { meta: Object.keys(meta).length, stats: Object.keys(stats).length, changes: changes.length };
}
