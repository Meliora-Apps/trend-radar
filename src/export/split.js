// Exportul pe tari: aceleasi fisiere ca exportFiles (build.js), dar fara o baza cu toate tarile odata.
// In Convex o actiune Node are 512 MB de memorie, ~512 MB de disc temporar si 10 minute; baza unei singure tari
// incape de cateva ori in aceste limite, cea cu toate tarile nu mai incapea (vezi convex/process.js).
//
//  1. countryParts(db, cc): pe baza tarii -> listele tarii (fisiere finale) + bucatile ei pentru fisierele comune:
//       memo/<CC>        bucatile listelor (aceleasi pe care lista ALL le refoloseste in exportFiles)
//       terms/<CC>/<g>   partea tarii din pagina fiecarui cuvant vazut in tara (grupa g de fisiere term/*)
//       apps/<CC>/<g>    partea tarii din pagina fiecarui app (grupa g de fisiere app/*)
//       info/<CC>        starea tarii, categoriile, problemele, prima zi cu scoruri (pentru `meta` si term/*)
//       seen/<CC>        cuvintele tarii, cu ultima zi in care au fost vazute (pentru `terms`)
//  2. din bucatile tuturor tarilor: mergeMeta (meta + terms), mergeLists (list/ALL/*), mergeTermGroup (term/*),
//     mergeAppGroup (app/*). Fiecare pas citeste doar bucatile lui, deci ruleaza separat, in paralel.
import { gzipSync, gunzipSync } from 'node:zlib';
import { COUNTRIES } from '../apple/clients.js';
import { genreName } from '../apple/genres.js';
import { makeViews, pickScore, categoriesFrom } from '../local/views.js';
import { tx, KINDS } from '../local/db.js';
import { marketEstimate, saturated } from '../metrics/niche.js';
import { listVariants } from './build.js';
import { shardOf, TERM_SHARDS, APP_SHARDS } from './shard.js';

export const TERM_GROUPS = 8;
export const APP_GROUPS = 8;

// Textul JSON.stringify(value), scris pe bucati intr-un Buffer: un JSON.stringify pe o lista de 33 MB tine in
// memoria V8 de cateva ori marimea ei (~200 MB pentru list/ALL/niches/30); asa, doar Buffer-ul final.
// Doar obiectele si listele simple se impart (primele `depth` niveluri); restul trece prin JSON.stringify.
export function jsonBuffer(value, depth = 3) {
  const out = [];
  let pending = '';
  const write = (str) => {
    pending += str;
    if (pending.length >= 1 << 16) { out.push(Buffer.from(pending)); pending = ''; }
  };
  const plain = (v) => v !== null && typeof v === 'object' && typeof v.toJSON !== 'function'
    && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const emit = (v, d) => {
    if (d === 0 || !plain(v)) { write(JSON.stringify(v) ?? 'null'); return; }
    if (Array.isArray(v)) {
      write('[');
      for (let i = 0; i < v.length; i++) {
        if (i) write(',');
        const x = v[i];
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') write('null');
        else emit(x, d - 1);
      }
      write(']');
      return;
    }
    write('{');
    let first = true;
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
      write(`${first ? '' : ','}${JSON.stringify(k)}:`);
      first = false;
      emit(x, d - 1);
    }
    write('}');
  };
  emit(value, depth);
  out.push(Buffer.from(pending));
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

// Fisierele finale: ca in build.js (acelasi JSON, acelasi nivel de compresie).
export const gzJson = (obj) => gzipSync(jsonBuffer(obj), { level: 6 });
// Bucatile sunt temporare (citite o data, apoi sterse): compresie mai rapida.
const gzPiece = (obj) => gzipSync(jsonBuffer(obj), { level: 3 });
export const fromGz = (buf) => JSON.parse(gunzipSync(buf).toString('utf8'));

// Un fisier cu mai multe bucati gzip: [lungimea antetului (4 octeti)] [antet JSON: [nume, inceput, lungime]...] [bucatile].
// Pasul care il citeste dezarhiveaza doar bucatile de care are nevoie.
export function pack(members) {
  const index = [];
  const bufs = [];
  let off = 0;
  for (const [name, buf] of members) {
    index.push([name, off, buf.length]);
    bufs.push(buf);
    off += buf.length;
  }
  const head = Buffer.from(JSON.stringify(index));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, ...bufs]);
}

export function unpack(buf) {
  const n = buf.readUInt32BE(0);
  const base = 4 + n;
  const at = new Map(JSON.parse(buf.subarray(4, base).toString('utf8')).map(([name, off, len]) => [name, [base + off, len]]));
  return {
    names: () => [...at.keys()],
    has: (name) => at.has(name),
    json: (name) => {
      const p = at.get(name);
      return p ? fromGz(buf.subarray(p[0], p[0] + p[1])) : undefined;
    },
  };
}

// Ordinea SQLite din exportFiles: ORDER BY length(term), term (caractere, apoi octetii UTF-8).
function sortTerms(terms) {
  return terms.map((t) => ({ t, n: [...t].length, b: Buffer.from(t) }))
    .sort((x, y) => x.n - y.n || Buffer.compare(x.b, y.b))
    .map((x) => x.t);
}
const binCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---- 1. pe baza unei tari ----

// Da, pe rand: ['file', cheie, gzip] (fisierele finale ale tarii) si ['piece', nume, continut] (bucatile).
export function* countryParts(db, cc, { log = () => {} } = {}) {
  let t = Date.now();
  const lap = () => { const ms = Date.now() - t; t = Date.now(); return `${Math.round(ms / 100) / 10} s`; };
  const memo = [];
  const views = makeViews(db, { memoSink: (key, value) => { if (!key.startsWith('trend:')) memo.push([key, gzPiece(value)]); } });

  for (const [key, fn] of listVariants()) if (key.split('/')[1] === cc) yield ['file', key, gzJson(fn(views))];
  yield ['piece', `memo/${cc}`, pack(memo)];
  log(`${cc}: liste in ${lap()} (${memo.length} bucati pentru ALL)`);
  memo.length = 0;
  views.forget();

  // Cuvintele: toate cele vazute sau clasificate in tara (si cele vechi: pagina unui cuvant inca activ in alta tara
  // arata si ce stim despre el aici). Un cuvant care lipseste = partea unui cuvant necunoscut in tara (template).
  // Istoria toata cu 0 = cea a unui cuvant nevazut: pastram doar semnul (history: 0).
  const seen = db.prepare('SELECT term, last_seen FROM seen WHERE country=?').all(cc);
  const classOnly = db.prepare('SELECT term FROM class WHERE country=? EXCEPT SELECT term FROM seen WHERE country=?').all(cc, cc);
  const template = views.termEntry(cc, '\u0000');
  const groups = Array.from({ length: TERM_GROUPS }, () => new Map());
  for (const { term } of [...seen, ...classOnly]) {
    const shard = shardOf(term, TERM_SHARDS);
    const g = groups[shard % TERM_GROUPS];
    if (!g.has(shard)) g.set(shard, []);
    g.get(shard).push(term);
  }
  for (let g = 0; g < TERM_GROUPS; g++) {
    const members = [];
    for (const [shard, terms] of groups[g]) {
      const out = {};
      for (const term of terms) {
        const e = views.termEntry(cc, term.trim().toLowerCase());
        out[term] = e.history.every((h) => h.score === 0) ? { ...e, history: 0 } : e;
      }
      members.push([`s${shard}`, gzPiece(out)]);
    }
    yield ['piece', `terms/${cc}/${g}`, pack(members)];
  }
  log(`${cc}: ${seen.length} cuvinte in ${lap()}`);

  let apps = 0;
  for (const [g, members, n] of countryAppGroups(db, cc, views)) {
    apps += n;
    yield ['piece', `apps/${cc}/${g}`, pack(members)];
  }
  log(`${cc}: ${apps} app-uri in ${lap()}`);

  yield ['piece', `seen/${cc}`, gzPiece(seen.map((r) => [r.term, r.last_seen]))];
  yield ['piece', `info/${cc}`, gzPiece({
    country: cc,
    scoresMin: db.prepare('SELECT MIN(date) d FROM scores WHERE country=?').get(cc).d ?? null,
    used: views.usedCategories(cc),
    status: views.countryStatus(cc),
    problems: db.prepare('SELECT * FROM problems').all(),
    template,
  })];
}

// Partea tarii din paginile app-urilor (ca appShards din build.js, pentru o singura tara), pe grupe de fisiere.
// Un app: k = cuvintele (termen, loc, scor, clasificat la, categorie), h = locurile/rating-urile pe zile,
// e = estimarea, c = ultimele 60 de schimbari.
function* countryAppGroups(db, cc, views) {
  db.exec(`DROP TABLE IF EXISTS temp.app_ids; DROP TABLE IF EXISTS temp.app_kw;
    CREATE TEMP TABLE app_ids (id INTEGER PRIMARY KEY, shard INTEGER);
    CREATE TEMP TABLE app_kw (id INTEGER, term TEXT, position INTEGER, score INTEGER, classified_at TEXT, category INTEGER)`);
  const addId = db.prepare('INSERT OR IGNORE INTO temp.app_ids VALUES (?,?)');
  const add = (id) => addId.run(id, shardOf(id, APP_SHARDS));
  const addKw = db.prepare('INSERT INTO temp.app_kw VALUES (?,?,?,?,?,?)');
  const estimates = new Map();
  tx(db, () => {
    const latest = db.prepare('SELECT MAX(date) d FROM days WHERE country=? AND complete=1').get(cc).d;
    const big = views.bigOf(cc);
    const score = db.prepare('SELECT term, score, score_adj FROM scores WHERE country=? AND date=?').all(cc, latest);
    const scoreOf = new Map(score.map((s) => [s.term, pickScore(big, s.term, s.score, s.score_adj)]));
    for (const r of db.prepare('SELECT term, top_app_ids, classified_at, category FROM class WHERE country=?').iterate(cc)) {
      JSON.parse(r.top_app_ids).forEach((id, i) => {
        add(id);
        addKw.run(id, r.term, i + 1, scoreOf.get(r.term) ?? 0, r.classified_at, r.category);
      });
    }
    for (const [id, v] of views.velocity(cc).map) {
      if (v.perDay == null) continue;
      add(id);
      estimates.set(id, { country: cc, perDay: v.perDay, ...marketEstimate(v.perDay) });
    }
    for (const r of db.prepare('SELECT DISTINCT id FROM app_hist WHERE country=?').iterate(cc)) add(r.id);
    for (const r of db.prepare('SELECT DISTINCT id FROM app_changes WHERE country=?').iterate(cc)) add(r.id);
  });
  db.exec('CREATE INDEX temp.app_ids_shard ON app_ids (shard); CREATE INDEX temp.app_kw_id ON app_kw (id)');

  const ids = db.prepare('SELECT id FROM temp.app_ids WHERE shard=? ORDER BY id');
  const kws = db.prepare(`SELECT k.* FROM temp.app_ids a JOIN temp.app_kw k ON k.id=a.id WHERE a.shard=?
    ORDER BY k.id, k.score DESC, k.position, k.term`);
  const hist = db.prepare(`SELECT h.id, h.date, h.dl, h.gr, h.st, h.ratings FROM temp.app_ids a
    JOIN app_hist h ON h.id=a.id AND h.country=? WHERE a.shard=? ORDER BY h.id, h.date`);
  const changes = db.prepare(`SELECT date, field, from_v "from", to_v "to", notes FROM app_changes
    WHERE id=? AND country=? ORDER BY date DESC, rowid LIMIT 60`);
  try {
    for (let g = 0; g < APP_GROUPS; g++) {
      const members = [];
      let n = 0;
      for (let shard = g; shard < APP_SHARDS; shard += APP_GROUPS) {
        const out = {};
        const of = (id) => (out[id] ??= {});
        for (const { id } of ids.iterate(shard)) {
          const a = of(id);
          n++;
          if (estimates.has(id)) a.e = estimates.get(id);
          const c = changes.all(id, cc);
          if (c.length) a.c = c;
        }
        for (const k of kws.iterate(shard)) (of(k.id).k ??= []).push([k.term, k.position, k.score, k.classified_at, genreName(k.category)]);
        for (const h of hist.iterate(cc, shard)) {
          const a = of(h.id);
          if (h.dl != null) ((a.h ??= {}).dl ??= []).push([h.date, h.dl]);
          if (h.gr != null) ((a.h ??= {}).gr ??= []).push([h.date, h.gr]);
          if (h.st) ((a.h ??= {}).st ??= []).push([h.date, h.ratings]);
        }
        members.push([`s${shard}`, gzPiece(out)]);
      }
      yield [g, members, n];
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.app_ids; DROP TABLE IF EXISTS temp.app_kw');
  }
}

// ---- 2. din bucatile tuturor tarilor ----
// `infos`, `bundles`: cate unul pe tara, in ordinea COUNTRIES (info = obiectul din info/<CC>, bundle = unpack(...)).

// Cuvintele cu pagina: vazute in zilele pastrate in baza (de la cea mai veche zi cu scoruri, in oricare tara).
const sinceOf = (infos) => infos.map((i) => i.scoresMin).filter(Boolean).sort()[0] ?? '';

const problemOrder = (p) => {
  const [kind, date, file] = p.path.split(/[\\/]/);
  return [KINDS.indexOf(kind), date ?? '', COUNTRIES.indexOf((file ?? '').slice(0, 2))];
};

// `seen`: cuvintele fiecarei tari ([[cuvant, ultima zi]], din seen/<CC>), in ordinea COUNTRIES.
export function mergeMeta(infos, seen, { cloud = null } = {}) {
  const used = new Set(infos.flatMap((i) => i.used));
  const problems = infos.flatMap((i) => i.problems).map((p) => ({ p, o: problemOrder(p) }))
    .sort((a, b) => a.o[0] - b.o[0] || a.o[1].localeCompare(b.o[1]) || a.o[2] - b.o[2]).map((x) => x.p);
  const meta = {
    generatedAt: new Date().toISOString(), countries: COUNTRIES, categories: categoriesFrom(used),
    status: { countries: Object.fromEntries(COUNTRIES.map((cc, i) => [cc, infos[i].status])), problems }, cloud,
  };
  const since = sinceOf(infos);
  const terms = new Set();
  for (const list of seen) for (const [term, lastSeen] of list) if (lastSeen >= since) terms.add(term);
  return [['meta', gzJson(meta)], ['terms', gzJson(sortTerms([...terms]))]];
}

// Listele ALL, in grupe (fiecare grupa = un pas separat, cu memoria lui): niches/30 singura are ~33 MB de JSON.
export const LIST_GROUPS = [['new'], ['rising', 'falling', 'top', 'gone'], ['niches'], ['breakouts', 'changes'], ['apps', 'themes', 'upcoming']];

// Listele ALL ale grupei `group` (null = toate), din bucatile tarilor (vederile fara baza: o bucata lipsa = eroare,
// nu o lista goala). Bucatile citite raman in memorie doar cat tine familia de variante care le foloseste:
// new/7/appeared, new/7/discovered si new/7/all citesc aceleasi bucati view:<CC>:new:7 (la fel changes/<p>/*,
// apps/charts/<p>/*), dar niches/7 si niches/30 nu au nimic comun.
export function* mergeLists(bundles, { group = null } = {}) {
  const cache = new Map();
  const source = (key) => {
    if (cache.has(key)) return cache.get(key);
    const b = bundles[COUNTRIES.indexOf(key.split(':')[1])];
    const value = b?.has(key) ? b.json(key) : undefined;
    cache.set(key, value);
    return value;
  };
  const views = makeViews(null, { memoSource: source });
  let family = null;
  for (const [key, fn] of listVariants()) {
    const [, cc, name] = key.split('/');
    if (cc !== 'ALL' || (group && !group.includes(name))) continue;
    const parts = key.split('/');
    const fam = parts.length >= 5 ? parts.slice(0, -1).join('/') : key;
    if (fam !== family) { cache.clear(); family = fam; }
    yield [key, gzJson(fn(views))];
  }
}

// Fisierele term/<shard> ale grupei g (shard % TERM_GROUPS === g), ca in exportFiles.
export function* mergeTermGroup(g, bundles, infos) {
  const since = sinceOf(infos);
  for (let shard = g; shard < TERM_SHARDS; shard += TERM_GROUPS) {
    const per = bundles.map((b) => b?.json(`s${shard}`) ?? {});
    const terms = new Set();
    // Ca in exportFiles: cuvintele din `seen` (lastSeen != null) vazute de la `since` incoace, in oricare tara.
    for (const p of per) for (const [term, e] of Object.entries(p)) if (e.lastSeen != null && e.lastSeen >= since) terms.add(term);
    const out = {};
    for (const term of sortTerms([...terms])) {
      const t = term.trim().toLowerCase();
      out[term] = {
        term: t,
        countries: COUNTRIES.map((cc, i) => {
          const e = per[i][term];
          if (!e) return infos[i].template;
          return e.history === 0 ? { ...e, history: infos[i].template.history } : e;
        }),
        saturated: saturated(t),
      };
    }
    yield [`term/${shard}`, gzJson(out)];
  }
}

// Fisierele app/<shard> ale grupei g (shard % APP_GROUPS === g), ca appShards din build.js.
export function* mergeAppGroup(g, bundles) {
  for (let shard = g; shard < APP_SHARDS; shard += APP_GROUPS) {
    const per = bundles.map((b) => b?.json(`s${shard}`) ?? {});
    const ids = new Set();
    for (const p of per) for (const id of Object.keys(p)) ids.add(Number(id));
    const out = {};
    for (const id of [...ids].sort((a, b) => a - b)) {
      const keywords = [];
      const changes = [];
      per.forEach((p, ci) => {
        for (const [term, position, score, classifiedAt, categoryName] of p[id]?.k ?? []) keywords.push({ ci, term, position, score, classifiedAt, categoryName });
        for (const c of p[id]?.c ?? []) changes.push({ ci, c });
      });
      keywords.sort((a, b) => b.score - a.score || a.position - b.position || a.ci - b.ci || binCmp(a.term, b.term));
      // Ca ORDER BY date DESC, rowid: in aceeasi zi, tarile in ordinea importului (COUNTRIES), apoi ordinea din fisier.
      changes.sort((a, b) => (a.c.date < b.c.date ? 1 : a.c.date > b.c.date ? -1 : a.ci - b.ci));
      const points = (kind) => COUNTRIES.map((cc, ci) => ({ country: cc, points: (per[ci][id]?.h?.[kind] ?? []).map(([date, score]) => ({ date, score })) }));
      out[id] = {
        keywords: keywords.map(({ ci, ...k }) => ({ country: COUNTRIES[ci], ...k })),
        ranks: { downloads: points('dl'), grossing: points('gr'), ratings: points('st') },
        estimates: per.map((p) => p[id]?.e).filter(Boolean),
        changes: changes.slice(0, 60).map(({ ci, c }) => ({ country: COUNTRIES[ci], ...c })),
      };
    }
    yield [`app/${shard}`, gzJson(out)];
  }
}

// Tot exportul dintr-o data, din bazele tarilor (Map CC -> baza): pentru teste si pentru calculul pe alt calculator.
export function* splitExport(dbs, { cloud = null, log = () => {} } = {}) {
  const pieces = new Map();
  for (const cc of COUNTRIES) {
    for (const [kind, key, buf] of countryParts(dbs.get(cc), cc, { log })) {
      if (kind === 'file') yield [key, buf];
      else pieces.set(key, buf);
    }
  }
  const infos = COUNTRIES.map((cc) => fromGz(pieces.get(`info/${cc}`)));
  const bundles = (prefix) => COUNTRIES.map((cc) => unpack(pieces.get(`${prefix}/${cc}`)));
  yield* mergeMeta(infos, COUNTRIES.map((cc) => fromGz(pieces.get(`seen/${cc}`))), { cloud });
  const memo = bundles('memo');
  for (const group of LIST_GROUPS) yield* mergeLists(memo, { group });
  for (let g = 0; g < TERM_GROUPS; g++) yield* mergeTermGroup(g, COUNTRIES.map((cc) => unpack(pieces.get(`terms/${cc}/${g}`))), infos);
  for (let g = 0; g < APP_GROUPS; g++) yield* mergeAppGroup(g, COUNTRIES.map((cc) => unpack(pieces.get(`apps/${cc}/${g}`))));
}
