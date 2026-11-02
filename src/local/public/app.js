import { lineChart } from './chart.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Varianta online (web/) inlocuieste cererile catre serverul local cu fisierele zilnice din Convex.
const api = globalThis.TR_API ?? (async (path, opts) => {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
});

// ---------- tooltip "?" ----------
const tipEl = $('#tip');
const tip = {
  show(html, x, y) {
    tipEl.innerHTML = html; tipEl.hidden = false;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = `${Math.min(x + 14, innerWidth - w - 8)}px`;
    tipEl.style.top = `${y + h + 20 > innerHeight ? y - h - 10 : y + 16}px`;
  },
  hide() { tipEl.hidden = true; },
};
document.addEventListener('mouseover', (e) => {
  const q = e.target.closest('[data-tip]');
  if (q) tip.show(esc(q.dataset.tip), e.clientX, e.clientY);
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tip.hide(); });
const q = (text) => `<span class="q" data-tip="${esc(text)}">?</span>`;

const HELP = {
  score: 'Scor estimat 0–100 din sugestiile App Store: 70–100 = apare după o singură literă, 40–69 = după 2 litere, 10–39 = doar după un cuvânt + spațiu. Mai sus în listă = scor mai mare. Cuvintele găsite doar după combinații rare de 2 litere (ex. „jt”, „zg”, „mt”) primesc −25, fiindcă puțini le tastează; excepție fac cele la care o aplicație cu acel cuvânt în nume e mare (ex. „vpn”). NU e volumul oficial Apple.',
  delta: 'Diferența dintre media scorului din ultimele 3 zile și media de acum 7 (sau 30) de zile. Zilele cu colectare incompletă nu se pun la socoteală.',
  then: 'Media scorului în fereastra de comparație (acum 7–9 zile, sau 30–32 zile).',
  category: 'Categoria majoritară a primelor 10 app-uri din căutarea pentru acest cuvânt (minim 4 din 10). „Mixt” = rezultate amestecate. „Neclasificat” = în coada de clasificare.',
  difficulty: 'Mediana numărului de rating-uri ale primelor 10 app-uri: ●○○ sub 1.000, ●●○ sub 50.000, ●●● peste.',
  confirmed: 'Confirmat = cuvântul a fost văzut din nou în cel puțin încă o zi din prima săptămână. Neconfirmat poate fi zgomot de o zi.',
  firstSeen: 'Prima zi în care cuvântul a apărut în sugestii în această țară, de când colectăm.',
  seenDays: 'În câte din cele 7 zile dinaintea ultimelor 3 a fost văzut.',
  seenOf: 'În câte zile de colectare (de la prima apariție până azi) a fost văzut cuvântul. 1/1 = abia a apărut. 3/3 = stă constant, semn de trend real. 1/3 = poate fi zgomot.',
  origin: 'Apărut = cuvântul a ieșit nou în sugestiile principale (după 1–2 litere) sau într-o căutare mai adâncă pe care o mai făcusem înainte și unde nu era. Acesta e trendul real. Descoperit = găsit prima dată când am căutat mai adânc după un cuvânt (ex. „ai photo …”): e nou pentru noi, dar lumea îl putea căuta și înainte.',
  releaseDate: 'Data primei lansări în App Store (de la Apple).',
  bestRank: 'Cel mai bun loc de azi în topurile pe care le urmărim (top 100 gratuite/plătite, pe categorii și subcategorii de jocuri). Lângă el: în ce top și în ce țară.',
  climb: 'Cu câte locuri a urcat față de acum 7 zile în același top. „nou în top” = acum 7 zile nu era în acel top. Dacă cel mai bun loc e într-un top colectat de curând, urcarea se arată în topul mai larg (scris dedesubt).',
  countryCount: 'În câte din cele 6 țări e în topuri azi. Un app nou prezent în multe țări e un succes serios.',
  inTopSince: 'Prima zi în care l-am văzut în vreun top în această țară (urmărim topurile din 12 oct 2026).',
  gross: 'Locul în topul încasărilor (Top Grossing) al categoriei: aplicația chiar face bani. Topul încasărilor îl urmărim din 21 oct 2026.',
  ratingsPerDay: 'Câte rating-uri noi primește pe zi (media pe ultimele până la 7 zile, adunat pe țări). E cel mai bun semn gratuit pentru descărcări: aproximativ 1–2% dintre cei care descarcă lasă rating. Dedesubt: totalul de rating-uri. Cifrele zilnice le adunăm din 21 oct 2026.',
  daysToTop: 'În câte zile de la lansare a intrat în topuri. Puține zile = a explodat din start. Doar pentru aplicațiile lansate după ce am început să urmărim topurile (12 oct 2026).',
  firstInFeed: 'Prima zi în care a apărut în lista „aplicații noi” a Apple.',
  opportunity: 'Oportunitate 0–100: jumătate cererea (scorul cuvântului + creșterea), jumătate cât de liberă e nișa (100 − concurența). Mare = mulți caută, puțini concurenți puternici.',
  demand: 'Cererea: scorul estimat de trafic al cuvântului azi și cât a crescut în 7 zile („nou” = cuvânt apărut recent).',
  competition: 'Concurența 0–100 din primele 10 aplicații din căutare: cât de mari sunt (rating-uri), câte au exact cuvântul în titlu și câte noi au reușit să intre. Mică = loc pentru noi.',
  freshApps: 'Câte din primele 10 aplicații pentru acest cuvânt sunt lansate în ultimele 6 luni. Multe = nou-veniții reușesc să urce, nișa e deschisă.',
  moneyApps: 'Câte din primele aplicații pentru acest cuvânt sunt azi în topul încasărilor: nișa aduce bani.',
  chance: 'Șansa ta 0–100: cât de ușor ar intra în primele 10 o aplicație NOUĂ, fără rating-uri. Crește când locurile sunt ținute de aplicații mici (sub 1.000 de rating-uri), când nou-veniții au reușit deja să intre, când concurenții nu s-au mai actualizat de un an, când utilizatorii dau note mici și când puțini au exact cuvântul în titlu. „≈” = măsurat înainte de regula nouă, estimat din concurență (se reface automat).',
  market: 'Bani în nișă, estimat: rating-urile pe zi ale primelor 10 aplicații × ~70 descărcări pe rating × 0,34 $ pe descărcare (venitul median la 60 de zile, RevenueCat 2026, aplicații cu abonament), pe o lună. E o ESTIMARE grosieră: realul poate fi de 2× mai mic sau mai mare. Bun ca să compari nișele între ele, nu ca cifră exactă. Avem nevoie de cel puțin 2 zile de cifre pentru aplicațiile din nișă.',
  recent: 'Rating-uri noi pe zi în ultimele până la 3 zile (adunat pe țări). Dedesubt: cât primea de obicei.',
  ratio: 'De câte ori mai multe rating-uri pe zi primește acum față de obicei (luat din cea mai slabă dintre ultimele zile: creșterea trebuie să țină minim 2 zile la rând). „De obicei” = zilele dinainte (când avem minim 4) sau, la aplicațiile lansate în ultimul an, media de la lansare. 3× sau mai mult = explozie: ceva s-a întâmplat (viral pe TikTok, featuring Apple, reclamă, trend nou).',
  estimate: 'Estimare din rating-urile pe zi: descărcări pe zi (~70 pe rating) și bani pe lună dacă ar câștiga cât media aplicațiilor cu abonament (0,34 $ pe descărcare). Interval larg: de 2× mai puțin până la 2× mai mult.',
  change: 'Ce s-a schimbat: nume nou (testează alte cuvinte cheie), versiune nouă (cu noutățile, la cei din topul încasărilor) sau preț nou. Ce schimbă cei care fac bani arată ce funcționează.',
  date: 'Ziua în care am observat schimbarea.',
  apps: 'Primele app-uri din căutarea App Store pentru acest cuvânt. Click pe iconiță = pagina aplicației. „în coadă” = cuvântul încă nu a fost clasificat; deschide cuvântul ca să vezi app-urile acum.',
};

// ---------- stare ----------
const VIEWS = {
  new: { title: 'Nou', periods: [[1, 'Ultimele 24h'], [7, 'Ultimele 7 zile'], [30, 'Ultimele 30 zile']], def: 7 },
  rising: { title: 'În creștere', periods: [[7, 'față de acum 7 zile'], [30, 'față de acum 30 zile']], def: 7 },
  falling: { title: 'În scădere', periods: [[7, 'față de acum 7 zile'], [30, 'față de acum 30 zile']], def: 7 },
  top: { title: 'Top trafic', periods: null },
  gone: { title: 'Dispărute', periods: null },
  niches: { title: 'Nișe calde', periods: [[7, 'Cuvinte noi (7 zile) + în creștere'], [14, 'Cuvinte noi (14 zile) + în creștere'], [30, 'Cuvinte noi (30 zile) + în creștere']], def: 14 },
  breakouts: { title: 'Explozii', periods: null },
  changes: { title: 'Schimbări', periods: [[7, 'Ultimele 7 zile'], [14, 'Ultimele 14 zile'], [30, 'Ultimele 30 zile']], def: 7 },
  apps: { title: 'Aplicații noi', periods: [[30, 'Lansate în ultimele 30 zile'], [90, 'Lansate în ultimele 90 zile'], [180, 'Lansate în ultimele 6 luni'], [365, 'Lansate în ultimul an']], def: 90 },
  themes: { title: 'Teme topuri', periods: null },
  search: { title: 'Caută kw', periods: null },
  app: { title: 'Aplicație', periods: null },
};
const state = { view: 'new', country: 'US', category: 'all', period: 7, origin: 'appeared', chartType: 'all', source: 'charts', who: 'money', allNiches: false, text: '', sort: null, rows: [], term: '', appId: null, appCountry: 'US', appKwAll: false };

const COLS = {
  country: { label: 'Țara' },
  term: { label: 'Cuvânt' },
  score: { label: 'Scor*', num: true, help: 'score' },
  then: { label: 'Atunci', num: true, help: 'then' },
  delta: { label: 'Δ', num: true, help: 'delta' },
  categoryName: { label: 'Categorie', help: 'category' },
  difficulty: { label: 'Dificultate', help: 'difficulty' },
  confirmed: { label: 'Stare', help: 'confirmed' },
  firstSeen: { label: 'Prima apariție', help: 'firstSeen' },
  seenDays: { label: 'Zile văzut', num: true, help: 'seenDays' },
  seenOf: { label: 'Văzut', num: true, help: 'seenOf' },
  apps: { label: 'Aplicații', help: 'apps' },
  icon: { label: '' },
  name: { label: 'Aplicație' },
  releaseDate: { label: 'Lansată', help: 'releaseDate' },
  bestRank: { label: 'Cel mai bun loc', num: true, help: 'bestRank' },
  climb: { label: 'Urcare 7z', num: true, help: 'climb' },
  countryCount: { label: 'Țări', num: true, help: 'countryCount' },
  inTopSince: { label: 'În top din', help: 'inTopSince' },
  origin: { label: 'Tip', help: 'origin' },
  gross: { label: 'Încasări', num: true, help: 'gross' },
  ratingsPerDay: { label: 'Rating-uri/zi', num: true, help: 'ratingsPerDay' },
  daysToTop: { label: 'Până în top', num: true, help: 'daysToTop' },
  firstInFeed: { label: 'În „noi” din', help: 'firstInFeed' },
  opportunity: { label: 'Oportunitate', num: true, help: 'opportunity' },
  demand: { label: 'Cerere', num: true, help: 'demand' },
  competition: { label: 'Concurență', num: true, help: 'competition' },
  freshApps: { label: 'Noi în top 10', num: true, help: 'freshApps' },
  moneyApps: { label: 'Fac bani', num: true, help: 'moneyApps' },
  chance: { label: 'Șansa ta', num: true, help: 'chance' },
  market: { label: 'Bani în nișă', num: true, help: 'market' },
  recent: { label: 'Rating-uri/zi acum', num: true, help: 'recent' },
  ratio: { label: 'Față de obicei', num: true, help: 'ratio' },
  estimate: { label: 'Estimare', num: true, help: 'estimate' },
  change: { label: 'Schimbare', help: 'change' },
  date: { label: 'Când', help: 'date' },
  lastSeen: { label: 'Ultima dată' },
};
const VIEW_COLS = {
  new: ['term', 'score', 'apps', 'origin', 'categoryName', 'difficulty', 'seenOf', 'firstSeen'],
  rising: ['term', 'score', 'then', 'delta', 'categoryName', 'difficulty', 'firstSeen'],
  falling: ['term', 'score', 'then', 'delta', 'categoryName', 'difficulty'],
  top: ['term', 'score', 'categoryName', 'difficulty', 'firstSeen'],
  gone: ['term', 'score', 'seenDays', 'lastSeen', 'categoryName'],
  apps: ['icon', 'name', 'releaseDate', 'bestRank', 'climb', 'gross', 'ratingsPerDay', 'countryCount', 'daysToTop'],
  feed: ['icon', 'name', 'releaseDate', 'ratingsPerDay', 'countryCount', 'firstInFeed'],
  niches: ['term', 'apps', 'opportunity', 'chance', 'demand', 'competition', 'market', 'moneyApps', 'categoryName'],
  breakouts: ['icon', 'name', 'releaseDate', 'recent', 'ratio', 'bestRank', 'gross', 'estimate'],
  changes: ['icon', 'name', 'date', 'change', 'gross'],
};
const APP_VIEWS = ['apps', 'breakouts', 'changes'];
const TYPE_LABEL = { topfreeapplications: 'gratuite', toppaidapplications: 'plătite', topgrossingapplications: 'încasări' };
const viewCols = () => VIEW_COLS[state.view === 'apps' && state.source === 'feed' ? 'feed' : state.view];
const compLabel = (v) => (v < 35 ? ['mică', 'up'] : v < 65 ? ['medie', ''] : ['mare', 'down']);
const fmtNum = (n) => (n == null ? '–' : n >= 10000 ? `${Math.round(n / 1000).toLocaleString('ro-RO')}k` : n.toLocaleString('ro-RO'));

const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',')}k` : String(Math.round(n)));
const fmtUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace('.', ',')}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
const approxUsd = (n) => (n < 100 ? 'sub $100' : `≈${fmtUsd(n)}`);
const estRange = (e) => `${fmtUsd(e.low)}–${fmtUsd(e.high)}`;
const SAT_TIP = { hard: 'Apple (regula 4.3) nu mai acceptă aplicații noi în această categorie decât dacă sunt clar diferite sau mai bune. Risc mare de respingere.', ban: 'Apple (regula 4.3) consideră aceste aplicații de calitate slabă: le respinge, iar trimiterile repetate pot duce la închiderea contului de dezvoltator.' };
const satBadge = (sat) => (sat ? `<span class="badge bad" data-tip="${esc(SAT_TIP[sat.level])}">Apple respinge: ${esc(sat.label)}</span>` : '');
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
const ago = (d) => {
  const n = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(d)) / 86400000);
  return n < 0 ? `peste ${-n} zile (pre-comandă)` : n === 0 ? "azi" : n === 1 ? "ieri" : n < 60 ? `acum ${n} zile` : `acum ${Math.round(n / 30)} luni`;
};
const diffDots = (d) => (d == null ? '<span class="muted">–</span>' : `<span class="diff">${'●'.repeat(d)}${'○'.repeat(3 - d)}</span>`);
function cell(col, r) {
  const v = r[col];
  switch (col) {
    case 'term': return `<td class="term"><a data-term="${esc(r.term)}">${esc(r.term)}</a>${r.sat || r.flooding || r.notNiche ? `<div class="meta">${r.notNiche ? `<span class="badge" data-tip="${esc(NOT_NICHE[r.notNiche])}">nu e nișă</span> ` : ''}${satBadge(r.sat)}${r.flooding ? ` <span class="badge warn" data-tip="${esc(`${r.niche.fresh90} din primele 10 sunt lansate în ultimele 90 de zile: alții au văzut deja nișa. Se poate intra, dar trebuie repede.`)}">se umple</span>` : ''}</div>` : ''}</td>`;
    case 'score': return `<td class="num">${v ?? '–'}<span class="scorebar"><i style="width:${Math.max(0, Math.min(100, v ?? 0))}%"></i></span></td>`;
    case 'delta': return `<td class="num ${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v}</td>`;
    case 'then': case 'seenDays': return `<td class="num">${v ?? '–'}</td>`;
    case 'categoryName': return `<td>${esc(v)}${r.subgenreName ? ` <span class="muted">· ${esc(r.subgenreName)}</span>` : ''}</td>`;
    case 'difficulty': return `<td>${diffDots(v)}</td>`;
    case 'origin': return `<td>${v === 'discovered' ? '<span class="badge">descoperit</span>' : '<span class="badge ok">apărut</span>'}${r.preliminary ? ` <span class="muted" data-tip="${esc(`Apărut după doar ${r.priorDays} ${r.priorDays === 1 ? 'zi' : 'zile'} de urmărire (sigur = 7+). Poate fi o fluctuație.`)}">bază scurtă</span>` : ''}</td>`;
    case 'icon': return `<td class="apps-cell" data-ids="${r.id}" data-cc="${r.country}"><span class="ico ph"></span></td>`;
    case 'name': return `<td class="appname"><a data-app="${r.id}" data-app-country="${r.country}" class="applink">${esc(r.name)}</a><div class="meta muted">${esc(r.categoryName)} · ${esc(r.seller)}</div></td>`;
    case 'releaseDate': return v ? `<td>${esc(fmtDate(v))}<div class="meta muted">${ago(v)}</div></td>` : '<td>–</td>';
    case 'bestRank': if (v == null) return '<td class="num muted" data-tip="Azi nu e în topurile de descărcări urmărite.">–</td>';
      return `<td class="num"><b>#${v}</b><div class="meta muted">${esc(r.bestChartName)} · ${TYPE_LABEL[r.type]} · ${r.country}</div></td>`;
    case 'climb': {
      const where = r.climbChartName ? `<div class="meta muted">în ${esc(r.climbChartName)}</div>` : '';
      if (r.newInChart) return `<td class="num"><span class="badge new">nou în top</span>${where}</td>`;
      if (v == null) return '<td class="num muted" data-tip="Topul ăsta îl colectăm de curând; urcarea apare după 7 zile.">–</td>';
      return `<td class="num ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v}${where}</td>`;
    }
    case 'countryCount': return `<td class="num" data-tip="${esc(r.countries.join(', '))}">${v}/6</td>`;
    case 'inTopSince': return v ? `<td>${esc(fmtDay(v))}</td>` : '<td>–</td>';
    case 'gross': return r.grossRank ? `<td class="num"><span class="badge money">face bani</span> <b>#${r.grossRank}</b><div class="meta muted">${esc(r.grossChartName)} · ${r.grossCountry ?? r.country}${r.grossCountries > 1 ? ` · ${r.grossCountries} țări` : ''}</div></td>` : '<td class="num muted">–</td>';
    case 'ratingsPerDay': return `<td class="num">${v == null ? '<span class="muted" data-tip="Avem nevoie de cel puțin 2 zile de cifre.">–</span>' : `<b class="${v >= 50 ? 'up' : ''}">+${fmtNum(v)}</b>`}<div class="meta muted">${fmtNum(r.ratings)} total${r.stars ? ` · ${r.stars.toFixed(1)}★` : ''}</div></td>`;
    case 'daysToTop': return `<td class="num">${v == null ? '<span class="muted">–</span>' : `<b>${v === 0 ? 'din prima zi' : `în ${v} ${v === 1 ? 'zi' : 'zile'}`}</b>`}${r.inTopSince ? `<div class="meta muted">din ${esc(fmtDay(r.inTopSince))}</div>` : ''}</td>`;
    case 'firstInFeed': return v ? `<td>${esc(fmtDay(v))} <span class="muted">· ${ago(v)}</span></td>` : '<td>–</td>';
    case 'opportunity': return v == null ? '<td class="num muted" data-tip="Concurența se măsoară la clasificarea cuvântului (se completează zilnic).">în coadă</td>'
      : `<td class="num"><b>${v}</b><span class="scorebar opp"><i style="width:${v}%"></i></span></td>`;
    case 'demand': return `<td class="num">${r.score}${r.isNew ? ' <span class="badge new">nou</span>' : ` <span class="up">+${r.delta}</span>`}</td>`;
    case 'competition': {
      if (v == null) return '<td class="num muted">–</td>';
      const [label, cls] = compLabel(v);
      const n = r.niche;
      return `<td class="num" data-tip="${esc(`Primele 10: mediana ${fmtNum(n.med)} rating-uri · nota medie ${n.stars ?? '–'}★ · ${n.title}/10 au cuvântul în titlu · ${n.fresh}/10 lansate în ultimele 6 luni`)}"><span class="${cls}">${label}</span> <span class="muted">${v}</span></td>`;
    }
    case 'chance': {
      if (v == null) return '<td class="num muted">–</td>';
      const n = r.niche;
      const why = r.chanceApprox ? 'Estimat din concurență (cuvânt măsurat înainte de regula nouă; se reface automat).'
        : `Din primele 10: ${n.weak} au sub 1.000 rating-uri · ${n.fresh90} lansate în ultimele 90 zile · ${n.stale} neactualizate de un an · nota medie ${n.stars ?? '–'}★ · ${n.title}/10 au cuvântul în titlu`;
      return `<td class="num" data-tip="${esc(why)}"><b class="${v >= 50 ? 'up' : v < 25 ? 'down' : ''}">${r.chanceApprox ? '≈' : ''}${v}</b></td>`;
    }
    case 'market': return v ? `<td class="num" data-tip="${esc(`≈ ${fmtNum(v.downloadsDay)} descărcări/zi în primele 10 (măsurat la ${r.marketApps}/10 aplicații). Bani pe lună: ${estRange(v)}.`)}"><b>${approxUsd(v.month)}</b><div class="meta muted">/lună · ${r.marketApps}/10</div></td>`
      : '<td class="num muted" data-tip="Nu avem încă rating-urile zilnice ale aplicațiilor din această nișă (le adunăm de la colectarea din 22 oct; trebuie minim 2 zile).">–</td>';
    case 'recent': return `<td class="num"><b class="up">+${fmtNum(v)}</b><div class="meta muted" data-tip="${esc(r.baselineKind === 'lifetime' ? 'De obicei = media de la lansare.' : 'De obicei = zilele dinainte.')}">obicei ${fmtNum(r.baseline)}/zi</div></td>`;
    case 'ratio': return `<td class="num"><b class="${v >= 10 ? 'up' : ''}">×${String(v).replace('.', ',')}</b></td>`;
    case 'estimate': return v ? `<td class="num" data-tip="${esc(`Interval: ${estRange(v)} pe lună (dacă monetizează ca media aplicațiilor cu abonament).`)}">≈${fmtK(v.downloadsDay)} desc./zi<div class="meta muted">${approxUsd(v.month)}/lună</div></td>` : '<td class="num muted">–</td>';
    case 'date': return `<td>${esc(fmtDay(v))}<div class="meta muted">${r.country}</div></td>`;
    case 'change': {
      if (r.field === 'name') return `<td><span class="badge new">nume nou</span> <span class="muted">${esc(r.from)}</span> → <b>${esc(r.to)}</b></td>`;
      if (r.field === 'price') return `<td><span class="badge money">preț</span> ${r.from ? `$${r.from}` : 'gratuit'} → <b>${r.to ? `$${r.to}` : 'gratuit'}</b></td>`;
      return `<td><span class="badge">versiune</span> ${esc(r.from)} → <b>${esc(r.to)}</b>${r.notes ? `<div class="meta muted notes">${esc(r.notes.length > 220 ? `${r.notes.slice(0, 220)}…` : r.notes)}</div>` : ''}</td>`;
    }
    case 'freshApps': return `<td class="num">${r.competition == null ? '<span class="muted">–</span>' : `${v}/10`}</td>`;
    case 'moneyApps': return `<td class="num">${v ? `<span class="badge money">${v}</span>` : '<span class="muted">–</span>'}</td>`;
    case 'seenOf': return `<td class="num"><span class="badge ${r.seenDays >= 2 ? 'ok' : 'new'}">${r.seenDays}/${r.ofDays} ${r.ofDays === 1 ? 'zi' : 'zile'}</span></td>`;
    case 'apps': return r.apps?.length
      ? `<td class="apps-cell" data-ids="${r.apps.join(',')}" data-cc="${r.country}">${r.apps.map(() => '<span class="ico ph"></span>').join('')}</td>`
      : '<td><span class="muted">în coadă</span></td>';
    case 'firstSeen': return v ? `<td>${esc(fmtDay(v))} <span class="muted">· ${ago(v)}</span></td>` : '<td>–</td>';
    case 'confirmed': return `<td>${v ? '<span class="badge ok">confirmat</span>' : '<span class="badge new">nou</span>'}</td>`;
    default: return `<td>${esc(v ?? '–')}</td>`;
  }
}

// ---------- status ----------
async function loadStatus() {
  const s = await api('/api/status');
  const parts = [];
  if (!s.cloud) {
    parts.push('<span class="pill warn">Nicio colectare din cloud încă</span>');
  } else {
    const age = s.ageHours != null ? `acum ${s.ageHours < 1 ? '<1' : Math.round(s.ageHours)}h` : '';
    parts.push(`<span class="pill ${s.stale ? 'warn' : 'ok'}">Ultima colectare: ${esc(s.cloud.lastRun)} ${age}</span>`);
    if (s.stale) parts.push('<span class="pill warn">Mai veche de 48h: colectarea din cloud nu a mai rulat</span>');
    const missing = Object.entries(s.cloud.countries).filter(([, c]) => c.missing || !c.complete).map(([cc]) => cc);
    if (missing.length) parts.push(`<span class="pill bad">Incomplet azi: ${missing.join(', ')}</span>`);
  }
  for (const [cc, c] of Object.entries(s.local.countries)) {
    if (c.days && !c.warmup.done) parts.push(`<span class="pill">${cc}: se adună baza ${c.warmup.count}/7 zile</span>`);
  }
  if (s.local.problems.length) parts.push(`<span class="pill bad" data-tip="${esc(s.local.problems.map((p) => `${p.path}: ${p.error}`).join('; '))}">${s.local.problems.length} fișiere cu probleme</span>`);
  $('#status').innerHTML = parts.join('');
  state.status = s;
}

async function loadMeta() {
  const m = await api('/api/meta');
  $('#f-country').innerHTML = [...m.countries.map((c) => `<option>${c}</option>`), '<option value="ALL">Toate 6</option>'].join('');
  $('#f-country').value = state.country;
  $('#f-category').innerHTML = ['<option value="all">Toate</option>',
    ...m.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`),
    '<option value="none">Neclasificat</option>'].join('');
  $('#f-category').value = state.category;
}

// ---------- randare ----------
function setupFilters() {
  const v = VIEWS[state.view];
  const isTable = !!VIEW_COLS[state.view];
  $('#filters').style.display = ['search', 'app'].includes(state.view) ? 'none' : '';
  $('#f-period-wrap').style.display = v.periods ? '' : 'none';
  $('#f-origin-wrap').style.display = state.view === 'new' ? '' : 'none';
  $('#f-type-wrap').style.display = state.view === 'apps' && state.source !== 'feed' ? '' : 'none';
  $('#f-source-wrap').style.display = state.view === 'apps' ? '' : 'none';
  $('#f-who-wrap').style.display = state.view === 'changes' ? '' : 'none';
  $('#f-text').style.display = isTable ? '' : 'none';
  $('#csv').style.display = isTable && !APP_VIEWS.includes(state.view) && state.view !== 'niches' ? '' : 'none';
  if (v.periods) {
    $('#f-period').innerHTML = v.periods.map(([val, label]) => `<option value="${val}">${label}</option>`).join('');
    if (!v.periods.some(([val]) => val === state.period)) state.period = v.def;
    $('#f-period').value = state.period;
  }
  $('#csv').href = `/api/csv?${new URLSearchParams({ name: state.view, country: state.country, category: state.category, period: state.period, origin: state.origin })}`;
}

function appsNotice(r) {
  if (state.source === 'feed') {
    $('#notice').innerHTML = r.total
      ? '<div class="notice info">Lansările noi din lista Apple („aplicații noi”), care încă NU sunt în topurile urmărite. Cele care primesc multe rating-uri pe zi sunt pe cale să intre în topuri: cel mai devreme semn de succes.</div>'
      : '<div class="notice">Lista lansărilor noi de la Apple se adună din 21 oct 2026. Revino după colectarea de mâine.</div>';
    return;
  }
  $('#notice').innerHTML = r.total ? '<div class="notice info">Aplicațiile apar aici după ce intră în top 100 al categoriei lor (gratuite, plătite sau încasări). Urmărim topurile din 12 oct 2026, subcategoriile de jocuri din 20 oct, iar topul încasărilor și rating-urile zilnice din 21 oct.</div>'
    : '<div class="notice">Încă nu avem datele de lansare ale aplicațiilor din topuri. Ele se adună la colectarea zilnică.</div>';
}

const NOT_NICHE = {
  money: 'Aplicațiile din primele locuri nu fac aproape nimic (sub ~$300/lună estimat): nimeni nu caută asta ca să plătească.',
  few: 'Apple găsește sub 6 aplicații: e o căutare izolată (un nume, un cod), nu o piață.',
  lang: 'Cuvânt în altă limbă decât cele ale țărilor urmărite: puțini oameni, greu de țintit.',
  brand: 'Căutare după o firmă sau o aplicație anume (ex. „georgia power”): oamenii vor exact aplicația aceea, nu una nouă.',
  mixed: 'Apple găsește aplicații din categorii fără legătură între ele: nu e clar ce caută oamenii (de obicei e numele unei firme sau al unui loc).',
  code: 'Un cod sau o prescurtare de 2–4 litere fără trafic dovedit (ex. „yfc”): nu știm ce caută oamenii.',
};

function nichesNotice(r) {
  const left = r.total - r.measured;
  const h = r.hidden ?? {};
  const parts = [h.money && `${h.money} unde aplicațiile din top nu fac aproape nimic (sub ~$300/lună)`,
    h.few && `${h.few} unde Apple găsește sub 6 aplicații (o căutare izolată, nu o piață)`,
    h.brand && `${h.brand} căutări după o firmă sau o aplicație anume`,
    h.code && `${h.code} coduri sau prescurtări de 2–4 litere`,
    h.mixed && `${h.mixed} cu rezultate amestecate (Apple nu știe ce sunt)`,
    h.lang && `${h.lang} în altă limbă`].filter(Boolean);
  const hiddenTxt = parts.length
    ? (state.allNiches
      ? ` Le arăt și pe cele care nu sunt nișe reale, la coada listei, marcate cu gri. <a href="#" id="niches-toggle">Ascunde-le</a>.`
      : ` Am ascuns ${parts.join(', ')}. <a href="#" id="niches-toggle">Arată-le</a>.`)
    : '';
  $('#notice').innerHTML = `<div class="notice info">Cuvintele noi și cele în creștere, cu cât de grea e concurența și cine face bani pe ele. Sus sunt nișele cu cerere mare și concurență mică: acolo merită să intri cu o aplicație. Căutările după o aplicație anume (mărci ca „google meet”) sunt ascunse.${hiddenTxt}${left > 0 ? ` La ${left} cuvinte concurența încă nu e măsurată (se completează zilnic, cele noi primele).` : ''}</div>`;
  $('#niches-toggle')?.addEventListener('click', (e) => { e.preventDefault(); state.allNiches = !state.allNiches; renderView(); });
}

function breakoutsNotice(r) {
  $('#notice').innerHTML = r.measured
    ? '<div class="notice info">Aplicațiile care primesc acum de cel puțin 3× mai multe rating-uri pe zi decât de obicei (minim 5 pe zi). Ceva le-a aprins: un video viral, featuring de la Apple, reclame sau un trend nou. Deschide aplicația ca să vezi pe ce cuvinte apare și de ce se plâng utilizatorii.</div>'
    : '<div class="notice">Exploziile apar după ce avem cel puțin 3 zile la rând de rating-uri zilnice: creșterea trebuie să țină minim 2 zile, ca să nu confundăm o cifră întârziată de la Apple cu o explozie. Le adunăm din 21 oct 2026, deci primele apar pe 23 oct.</div>';
}

function changesNotice(r) {
  $('#notice').innerHTML = `<div class="notice info">${state.who === 'money' ? 'Doar aplicațiile din topul încasărilor: ce schimbă cei care fac bani.' : 'Toate aplicațiile urmărite.'} Numele nou = testează alte cuvinte cheie. Versiunea nouă = ce funcții adaugă (textul noutăților îl păstrăm la cei care fac bani). Prețul = își testează monetizarea. Schimbările de nume și versiune le urmărim din 22 oct 2026.</div>`;
}

function notice(meta) {
  const notes = [];
  if (['new', 'gone'].includes(state.view)) {
    for (const [cc, m] of Object.entries(meta)) {
      const prelim = state.view === 'new' && state.rows.some((r) => r.country === cc && r.preliminary);
      if (m.warmup.done && !prelim) continue;
      if (prelim) notes.push(`${cc}: cuvintele marcate „bază scurtă” au apărut când aveam mai puțin de 7 zile de istoric, deci pot fi doar fluctuații. Uită-te la coloana „Văzut”: cele văzute în fiecare zi sunt trenduri reale.`);
      else notes.push(`${cc}: se adună baza ${m.warmup.count}/7 zile. Până atunci nu putem spune ce e „${state.view === 'new' ? 'nou' : 'dispărut'}”${state.view === 'new' ? ' (trebuie minim 2 zile)' : ''}.`);
    }
  }
  if (['rising', 'falling'].includes(state.view) && Object.values(meta).every((m) => !m.latest)) {
    notes.push('Încă nu sunt zile complete colectate.');
  }
  $('#notice').innerHTML = notes.map((n) => `<div class="notice">${esc(n)}</div>`).join('');
}

const SORT_KEY = { market: (r) => r.market?.month ?? null, estimate: (r) => r.estimate?.month ?? null, seenOf: (r) => r.seenDays / r.ofDays, apps: (r) => r.apps?.length ?? 0, demand: (r) => r.score, gross: (r) => (r.grossRank == null ? null : -r.grossRank), daysToTop: (r) => (r.daysToTop == null ? null : -r.daysToTop) };
const sortVal = (r, c) => (SORT_KEY[c] ? SORT_KEY[c](r) : r[c]);
function renderTable() {
  let cols = viewCols();
  if (state.country === 'ALL' && !APP_VIEWS.includes(state.view)) cols = ['country', ...cols];
  const t = state.text.trim().toLowerCase();
  let rows = t ? state.rows.filter((r) => (r.term ?? r.name).toLowerCase().includes(t)) : [...state.rows];
  if (state.sort) {
    const { col, dir } = state.sort;
    rows.sort((a, b) => {
      const x = sortVal(a, col), y = sortVal(b, col);
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  const head = cols.map((c) => {
    const def = COLS[c];
    const arrow = state.sort?.col === c ? `<span class="arrow">${state.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    return `<th class="${def.num ? 'num' : ''}" data-sort="${c}">${def.label}${def.help ? q(HELP[def.help]) : ''} ${arrow}</th>`;
  }).join('');
  const shown = rows.slice(0, 500);
  $('#content').innerHTML = rows.length
    ? `<p class="count">${rows.length} ${state.view === 'changes' ? 'schimbări' : APP_VIEWS.includes(state.view) ? 'aplicații' : 'cuvinte'}${rows.length > shown.length ? ` · afișate primele ${shown.length} ${[...APP_VIEWS, 'niches'].includes(state.view) ? ' (filtrează ca să vezi restul)' : ' (exportă CSV pentru toate)'}` : ''}${state.total > state.rows.length ? ` · total ${state.total}` : ''}</p>
       <div class="card"><table><thead><tr>${head}</tr></thead>
       <tbody>${shown.map((r) => `<tr${r.notNiche ? ' class="dim"' : ''}>${cols.map((c) => cell(c, r)).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="card empty">Nimic de afișat pentru filtrele alese.</div>';
  loadIcons().catch(() => {});
}

// Iconitele din coloana "Aplicatii": cerute in loturi pe tara, tinute in memorie.
const appInfo = new Map(); // `${cc}:${id}` -> app
async function loadIcons() {
  const cells = [...document.querySelectorAll('.apps-cell')];
  if (!cells.length) return;
  const byCc = new Map();
  for (const c of cells) {
    for (const id of c.dataset.ids.split(',')) {
      if (!appInfo.has(`${c.dataset.cc}:${id}`)) {
        if (!byCc.has(c.dataset.cc)) byCc.set(c.dataset.cc, new Set());
        byCc.get(c.dataset.cc).add(id);
      }
    }
  }
  const fill = () => {
    for (const c of cells) {
      if (!c.isConnected || c.dataset.done) continue;
      const apps = c.dataset.ids.split(',').map((id) => appInfo.get(`${c.dataset.cc}:${id}`));
      if (apps.some((a) => a === undefined)) continue;
      c.dataset.done = '1';
      c.innerHTML = apps.filter(Boolean).map((a) => `<a data-app="${a.id}" data-app-country="${c.dataset.cc}" class="applink ico" data-tip="${esc(`${a.name} · ${a.ratings.toLocaleString('ro-RO')} rating-uri`)}"><img src="${esc(a.icon)}" alt="" loading="lazy"></a>`).join('');
    }
  };
  fill();
  for (const [cc, set] of byCc) {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const apps = await api(`/api/apps?ids=${chunk.join(',')}&country=${cc}`);
      for (const id of chunk) appInfo.set(`${cc}:${id}`, null); // app scos din magazin
      for (const a of apps) appInfo.set(`${cc}:${a.id}`, a);
      fill();
    }
  }
}

// Rezultatele listelor raman in memorie: la "Inapoi" lista apare instant, fara recalculare.
const viewCache = new Map();

async function renderView(scrollY = 0) {
  setupFilters();
  syncControls();
  $('#notice').innerHTML = '';
  if (state.view === 'search') { renderSearch(); return window.scrollTo(0, 0); }
  if (state.view === 'app') { await renderApp(); return window.scrollTo(0, scrollY); }
  if (state.view === 'themes') { await renderThemes(); return window.scrollTo(0, scrollY); }
  const params = new URLSearchParams({ name: state.view, country: state.country, category: state.category, period: state.period, origin: state.origin, type: state.chartType, source: state.source, who: state.who, all: state.allNiches ? '1' : '0' });
  const key = params.toString();
  if (!viewCache.has(key)) {
    $('#content').innerHTML = '<div class="empty">Se calculează…</div>';
    const endpoint = { apps: '/api/new-apps', niches: '/api/niches', breakouts: '/api/breakouts', changes: '/api/changes' }[state.view] ?? '/api/view';
    viewCache.set(key, await api(`${endpoint}?${params}`));
  }
  const r = viewCache.get(key);
  state.rows = r.rows; state.total = r.total;
  if (state.view === 'apps') appsNotice(r);
  else if (state.view === 'niches') nichesNotice(r);
  else if (state.view === 'breakouts') breakoutsNotice(r);
  else if (state.view === 'changes') changesNotice(r);
  else notice(r.meta);
  renderTable();
  window.scrollTo(0, scrollY);
}

// ---------- istoric (butonul Inapoi al browserului / gestul de pe trackpad) ----------
history.scrollRestoration = 'manual';
const snapshot = () => ({
  view: state.view, country: state.country, category: state.category, period: state.period,
  origin: state.origin, chartType: state.chartType, source: state.source, who: state.who, term: state.term, text: state.text, sort: state.sort, from: state.from ?? null,
  appId: state.appId, appCountry: state.appCountry, appKwAll: state.appKwAll,
});
// Pagina noua: memoram unde eram (inclusiv scroll-ul) in intrarea curenta, apoi adaugam una noua.
function navigate(changes) {
  history.replaceState({ ...snapshot(), scrollY: window.scrollY }, '');
  Object.assign(state, changes);
  history.pushState(snapshot(), '');
  renderView(0).catch(showError);
}
// Schimbare de filtre pe aceeasi pagina: nu adauga pas nou in istoric.
const remember = () => history.replaceState({ ...snapshot(), scrollY: window.scrollY }, '');
window.addEventListener('popstate', (e) => {
  if (!e.state) return;
  Object.assign(state, e.state);
  renderView(e.state.scrollY ?? 0).catch(showError);
});
function syncControls() {
  document.querySelectorAll('#nav a').forEach((x) => x.classList.toggle('active', x.dataset.view === state.view));
  $('#f-country').value = state.country;
  $('#f-category').value = state.category;
  $('#f-origin').value = state.origin;
  $('#f-type').value = state.chartType;
  $('#f-source').value = state.source;
  $('#f-who').value = state.who;
  $('#f-text').value = state.text;
}

async function renderThemes() {
  $('#content').innerHTML = '<div class="empty">Se calculează…</div>';
  const groups = await api(`/api/themes?${new URLSearchParams({ country: state.country, category: state.category })}`);
  if (!groups.length) { $('#content').innerHTML = '<div class="card empty">Încă nu sunt topuri colectate.</div>'; return; }
  const noHistory = groups.every((g) => g.historyDays === 0);
  $('#notice').innerHTML = noHistory
    ? '<div class="notice">Topurile au o singură zi colectată: „nou intrat” și „urcare” apar după ce avem cel puțin o zi anterioară (urcarea pe 7 zile cere o săptămână).</div>'
    : '';
  $('#content').innerHTML = `<div class="themes">${groups.map((g) => `
    <div class="card theme-card">
      <h3>${esc(g.genreName)} ${state.country === 'ALL' ? `<span class="muted">· ${g.country}</span>` : ''}</h3>
      <div class="sub">${g.movers.length} app-uri noi sau în urcare · ${g.date}</div>
      ${g.themes.slice(0, 8).map((t) => `
        <details class="theme"><summary><b>${esc(t.theme)}</b><span class="muted">${t.count} app-uri</span></summary>
          <ul>${t.apps.map((a) => `<li><a data-app="${a.id}" data-app-country="${g.country}" class="applink">${esc(a.name)}</a> <span class="muted">· #${a.rank} ${a.kind === 'new' ? 'nou intrat' : `↑${a.climb}`} · ${TYPE_LABEL[a.type]}</span></li>`).join('')}</ul>
        </details>`).join('') || '<div class="muted">Nicio temă comună (minim 2 app-uri).</div>'}
      ${g.movers.length ? `<div class="movers">Mișcări: ${g.movers.slice(0, 6).map((m) => esc(m.name)).join(' · ')}${g.movers.length > 6 ? ' …' : ''}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ---------- Cauta kw ----------
function renderSearch() {
  const back = state.from ? `<button type="button" class="btn ghost back" id="back">← Înapoi la ${esc(VIEWS[state.from]?.title ?? 'listă')}</button>` : '';
  $('#content').innerHTML = `${back}
    <div class="search-box"><input id="kw" type="search" placeholder="Scrie un cuvânt-cheie, ex: ai photo" autocomplete="off" value="${esc(state.term)}"><div class="ac" id="ac" hidden></div></div>
    <div id="kw-result"></div>`;
  const input = $('#kw'), ac = $('#ac');
  $('#back')?.addEventListener('click', () => history.back());
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = input.value.trim();
      if (v.length < 2) { ac.hidden = true; return; }
      const list = await api(`/api/suggest?q=${encodeURIComponent(v)}`);
      ac.innerHTML = list.map((t) => `<div data-pick="${esc(t)}">${esc(t)}</div>`).join('');
      ac.hidden = !list.length;
    }, 150);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { ac.hidden = true; showTerm(input.value); } });
  ac.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pick]')?.dataset.pick;
    if (t) { input.value = t; ac.hidden = true; showTerm(t); }
  });
  if (state.term) showTerm(state.term); else input.focus();
}

async function showTerm(term) {
  term = term.trim().toLowerCase();
  if (!term) return;
  state.term = term;
  remember();
  const out = $('#kw-result');
  out.innerHTML = '<div class="empty">Se încarcă…</div>';
  const r = await api(`/api/term?q=${encodeURIComponent(term)}`);
  const seen = r.countries.filter((c) => c.firstSeen);
  const withApps = r.countries.find((c) => c.topAppIds.length);
  const liveCc = withApps ? null : (r.countries.find((c) => c.country === state.country && c.firstSeen) ?? seen[0])?.country;
  const nicheCc = withApps?.country ?? liveCc ?? state.country;
  const trendsCc = (seen[0]?.country ?? state.country) === 'ALL' ? 'US' : (seen[0]?.country ?? 'US');
  const gt = (cc) => `https://trends.google.com/trends/explore?date=today%2012-m&geo=${cc}&q=${encodeURIComponent(term)}`;
  out.innerHTML = `
    ${r.saturated ? `<div class="notice">${satBadge(r.saturated)} ${esc(SAT_TIP[r.saturated.level])}</div>` : ''}
    <div class="grid2">
      <div class="card panel"><h3>Scor estimat în timp ${q(HELP.score)}</h3><div class="chart" id="kw-chart"></div>
        <div class="muted small trends-links">Cererea în afara App Store (Google Trends, 12 luni) ${q('Dacă și pe Google căutările cresc, cererea e reală, nu doar în App Store. Dacă graficul are vârfuri în fiecare an în aceeași lună, e un trend sezonier.')}: ${['US', 'GB', 'DE', 'FR', 'IT', 'ES'].map((cc) => `<a href="${gt(cc)}" target="_blank" rel="noopener"${cc === trendsCc ? ' class="on"' : ''}>${cc} ↗</a>`).join('')}</div></div>
      <div class="card panel"><h3>Primele app-uri ${withApps ? `<span class="muted">(${withApps.country})</span>` : liveCc ? `<span class="muted">(${liveCc}, căutat acum ${q('Cuvântul nu e clasificat încă, așa că am căutat acum în App Store.')})</span>` : ''}</h3><ul class="apps" id="kw-apps"><li class="muted">${withApps || liveCc ? 'Se încarcă…' : 'Cuvântul nu e clasificat încă.'}</li></ul></div>
    </div>
    <div class="card" style="margin-top:14px"><table><thead><tr>
      <th>Țara</th><th class="num">Scor azi ${q(HELP.score)}</th><th>Apare la</th><th>Categorie ${q(HELP.category)}</th>
      <th>Concurență ${q(HELP.competition)}</th><th class="num">Șansa ta ${q(HELP.chance)}</th><th class="num">Bani în nișă ${q(HELP.market)}</th><th>Prima apariție ${q(HELP.firstSeen)}</th><th>Ultima</th></tr></thead>
      <tbody>${r.countries.map((c) => `<tr>
        <td>${c.country}</td>
        <td class="num">${c.last && c.last.date === c.lastSeen ? c.last.score : '–'}</td>
        <td>${c.last ? `„${esc(c.last.prefix)}” → poziția ${c.last.position}${c.last.rare ? ` <span class="muted" data-tip="Combinație rară de litere: puțini oameni o tastează, deci scorul e redus cu 25. Dacă o aplicație cu acest cuvânt în nume e mare, scorul revine întreg.">· rară −25</span>` : ''}` : '<span class="muted">nevăzut</span>'}</td>
        <td>${esc(c.category ?? '–')}${c.subgenre ? ` <span class="muted">· ${esc(c.subgenre)}</span>` : ''}</td>
        <td>${c.competition == null ? '<span class="muted">–</span>' : `<span class="${compLabel(c.competition)[1]}">${compLabel(c.competition)[0]}</span> <span class="muted">${c.competition} · ${c.niche.fresh}/10 noi</span>`}</td>
        <td class="num">${c.chance ? `<b class="${c.chance.value >= 50 ? 'up' : c.chance.value < 25 ? 'down' : ''}">${c.chance.approx ? '≈' : ''}${c.chance.value}</b>` : '<span class="muted">–</span>'}</td>
        <td class="num">${c.market ? `<span data-tip="${esc(`≈ ${fmtNum(c.market.downloadsDay)} descărcări/zi · ${estRange(c.market)} pe lună · măsurat la ${c.market.apps}/10 aplicații`)}">${approxUsd(c.market.month)}/lună</span>` : '<span class="muted">–</span>'}</td>
        <td>${esc(c.firstSeen ?? '–')}</td><td>${esc(c.lastSeen ?? '–')}</td></tr>`).join('')}</tbody></table></div>
    <div class="card panel" style="margin-top:14px" id="niche-reviews"><h3>De ce se plâng utilizatorii în această nișă ${q('Recenziile recente ale primelor 5 aplicații pentru acest cuvânt, adunate la un loc. Dacă toți se plâng de același lucru (reclame, abonament scump, lipsește o funcție), acolo e ușa ta de intrare.')}</h3>
      <button type="button" class="btn" id="load-niche-reviews">Citește recenziile primelor 5 aplicații (${esc(nicheCc)})</button></div>
    ${seen.length ? '' : '<div class="notice info" style="margin-top:14px">Cuvântul nu a apărut în sugestiile colectate. Poate fi prea puțin căutat sau e mai lung decât ce prindem (2 litere + extindere).</div>'}`;
  lineChart($('#kw-chart'), r.countries.map((c) => ({ country: c.country, points: c.history })), tip);
  $('#load-niche-reviews').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Se citesc recenziile (câteva secunde)…';
    const box = $('#niche-reviews');
    try {
      const nr = await api(`/api/niche-reviews?term=${encodeURIComponent(term)}&country=${nicheCc}`);
      if (state.term !== term || !box.isConnected) return;
      box.innerHTML = reviewsHtml(nr, `De ce se plâng utilizatorii în nișă <span class="muted small">(${nr.apps.map((a) => esc(a.name)).join(', ')})</span>`, 'Aplicațiile din nișă nu au recenzii recente.');
    } catch (err) { box.innerHTML = `<h3>De ce se plâng utilizatorii în nișă</h3><div class="empty">Nu am putut încărca recenziile: ${esc(err.message)}</div>`; }
  });
  if (withApps || liveCc) {
    const cc = withApps?.country ?? liveCc;
    try {
      const apps = withApps
        ? await api(`/api/apps?ids=${withApps.topAppIds.join(',')}&country=${cc}`)
        : await api(`/api/live-apps?term=${encodeURIComponent(term)}&country=${cc}`);
      $('#kw-apps').innerHTML = apps.map((a, i) => `<li><span class="muted">${i + 1}</span><img src="${esc(a.icon)}" alt="" loading="lazy">
        <div><a data-app="${a.id}" data-app-country="${cc}" class="applink">${esc(a.name)}</a> <a class="muted ext" href="${esc(a.url)}" target="_blank" rel="noopener" title="Deschide în App Store">↗</a>
        <div class="meta">${esc(a.seller)} · ${a.ratings.toLocaleString('ro-RO')} rating-uri${a.rating ? ` · ${a.rating.toFixed(1)}★` : ''}</div></div></li>`).join('');
    } catch (err) {
      $('#kw-apps').innerHTML = `<li class="muted">Nu am putut încărca app-urile: ${esc(err.message)}</li>`;
    }
  }
}

// ---------- Pagina aplicatiei ----------
const SOURCE = {
  title: ['titlu', 'Toate cuvintele sunt în titlu.'],
  subtitle: ['subtitlu', 'Toate cuvintele sunt în subtitlu.'],
  both: ['titlu + subtitlu', 'Cuvintele sunt împărțite între titlu și subtitlu.'],
  partial: ['parțial', 'Doar o parte din cuvinte sunt în titlu/subtitlu; restul vin probabil din câmpul ascuns de keywords.'],
  hidden: ['ascuns', 'Niciun cuvânt nu e în titlu sau subtitlu: aproape sigur e în câmpul ascuns de keywords (100 caractere) al aplicației.'],
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const fmtSize = (b) => (b ? `${(b / 1048576).toFixed(0)} MB` : '–');
const chars = (s, max) => `<span class="${(s ?? '').length > max ? 'down' : 'muted'}">${(s ?? '').length}/${max}</span>`;
const multiline = (s) => esc(s).replace(/\n/g, '<br>');

async function renderApp() {
  const backLabel = state.from ? `← Înapoi la ${esc(VIEWS[state.from]?.title ?? 'listă')}` : '← Înapoi';
  const back = `<button type="button" class="btn ghost back" id="back">${backLabel}</button>`;
  $('#content').innerHTML = `${back}<div class="empty">Se încarcă aplicația…</div>`;
  $('#back').addEventListener('click', () => history.back());
  const r = await api(`/api/app?id=${state.appId}&country=${state.appCountry}`);
  const d = r.detail;
  if (!d) {
    $('#content').innerHTML = `${back}<div class="card empty">Aplicația nu e disponibilă în ${esc(r.country)}. Încearcă altă țară: ${countryChips()}</div>`;
    return bindApp();
  }
  const kws = state.appKwAll ? r.keywords : r.keywords.filter((k) => k.country === r.country);
  const hiddenWords = [...new Set(r.keywords.filter((k) => k.country === r.country && k.source === 'hidden').flatMap((k) => k.term.split(' ')))];
  $('#content').innerHTML = `${back}
    <div class="card panel app-head">
      <img src="${esc(d.icon)}" alt="" class="app-icon">
      <div class="app-titles">
        <h2>${esc(d.name)} ${chars(d.name, 30)}</h2>
        <div class="app-sub">${d.subtitle ? `${esc(d.subtitle)} ${chars(d.subtitle, 30)}` : '<span class="muted">fără subtitlu (sau indisponibil)</span>'}</div>
        <div class="muted"><a href="${esc(d.sellerUrl)}" target="_blank" rel="noopener">${esc(d.seller)}</a> · ${esc(d.genres.join(', '))}</div>
        <div class="app-stats">
          <span><b>${d.rating ? d.rating.toFixed(1) : '–'}★</b> ${d.ratings.toLocaleString('ro-RO')} rating-uri</span>
          <span><b>${esc(d.price || '–')}</b></span>
          <span>v${esc(d.version)} · actualizat ${fmtDate(d.updated)}</span>
          <span>lansat ${fmtDate(d.released)}</span>
          ${(() => { const e = r.estimates.find((x) => x.country === r.country) ?? r.estimates[0]; return e ? `<span data-tip="${esc(`${HELP.estimate} În ${e.country}: +${e.perDay} rating-uri/zi. Interval: ${estRange(e)} pe lună.`)}"><b>≈${fmtNum(e.downloadsDay)}</b> descărcări/zi · <b>${approxUsd(e.month)}</b>/lună <span class="muted">(${e.country}, estimat)</span></span>` : ''; })()}
          <span>${fmtSize(d.sizeBytes)} · iOS ${esc(d.minOs)}+ · ${esc(d.ageRating)}</span>
        </div>
        <div class="app-country">Metadata din: ${countryChips()} <a class="muted" href="${esc(d.url)}" target="_blank" rel="noopener">App Store ↗</a></div>
      </div>
    </div>

    ${shotsCard(d)}
    <div class="grid2" style="margin-top:14px">
      <div class="card">
        <div class="panel-head">
          <h3>Cuvinte pe care apare în top 10 ${q('Din datele noastre: pentru fiecare cuvânt clasificat am salvat primele 10 app-uri din căutare. Arată doar cuvintele din colecția noastră care au fost clasificate (se completează zilnic), nu toate cuvintele posibile.')}</h3>
          <label class="muted small"><input type="checkbox" id="kw-all" ${state.appKwAll ? 'checked' : ''}> toate țările</label>
        </div>
        ${kws.length ? `<table><thead><tr>${state.appKwAll ? '<th>Țara</th>' : ''}<th>Cuvânt</th><th class="num">Poziție</th>
          <th class="num">Scor* ${q(HELP.score)}</th><th>Sursă ${q('De unde vine cuvântul pentru această aplicație: titlu, subtitlu sau câmpul ascuns de keywords. Se calculează doar pentru țara metadatelor afișate.')}</th></tr></thead>
          <tbody>${kws.map((k) => `<tr>${state.appKwAll ? `<td>${k.country}</td>` : ''}
            <td class="term"><a data-term="${esc(k.term)}">${esc(k.term)}</a></td>
            <td class="num">#${k.position}</td>
            <td class="num">${k.score}<span class="scorebar"><i style="width:${k.score}%"></i></span></td>
            <td>${k.source ? `<span class="badge src-${k.source}" data-tip="${esc(SOURCE[k.source][1])}">${SOURCE[k.source][0]}</span>` : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table>`
          : `<div class="empty">Nu apare în top 10 la niciun cuvânt clasificat încă${state.appKwAll ? '' : ` în ${esc(r.country)}`}. Clasificarea se completează zilnic.</div>`}
        ${hiddenWords.length ? `<div class="panel hidden-kw"><b>Probabil în câmpul ascuns de keywords:</b> ${hiddenWords.map((w) => `<span class="badge">${esc(w)}</span>`).join(' ')}</div>` : ''}
      </div>
      <div class="card panel">
        <h3>Descriere</h3>
        <div class="desc">${multiline(d.description)}</div>
        ${d.releaseNotes ? `<h3 style="margin-top:14px">Noutăți (v${esc(d.version)})</h3><div class="desc short">${multiline(d.releaseNotes)}</div>` : ''}
        <div class="muted small" style="margin-top:12px">Limbi: ${esc(d.languages.join(', '))} · Bundle: ${esc(d.bundleId)}</div>
      </div>
    </div>
    <div class="card panel" style="margin-top:14px">
      <div class="panel-head"><h3>Evoluție, zi de zi ${q('Pe fiecare țară. Locul în topuri: #1 = sus, linia se rupe în zilele în care nu era în niciun top. Rating-uri: totalul din fiecare zi; panta arată cât de repede crește (semnul descărcărilor).')}</h3>
        <div class="tabs">${EVO.map(([k, label]) => `<button type="button" class="chip${(state.evo ?? 'downloads') === k ? ' on' : ''}" data-evo="${k}">${label}</button>`).join('')}</div></div>
      <div class="chart" id="rank-chart"></div></div>
    <div class="grid2" style="margin-top:14px">
      <div class="card panel"><h3>Cumpărături în aplicație ${q('Ce vinde aplicația și la ce preț (Apple arată primele ~10). Abonamentele și pachetele scumpe arată cât de bine se monetizează nișa.')}</h3>${iapHtml(d)}</div>
      <div class="card panel"><h3>Aplicații similare ${q('„Ți-ar mai plăcea” din App Store: aplicațiile pe care le descarcă aceiași oameni. E nișa în care concurează aplicația.')}</h3>${similarHtml(r.similar, r.country)}</div>
    </div>
    ${r.changes.length ? `<div class="card panel" style="margin-top:14px"><h3>Ce a schimbat ${q(HELP.change)}</h3>
      <table><tbody>${r.changes.map((c) => `<tr><td>${esc(fmtDay(c.date))} <span class="muted">${c.country}</span></td><td>${c.field === 'name' ? `<span class="badge new">nume nou</span> <span class="muted">${esc(c.from)}</span> → <b>${esc(c.to)}</b>` : `<span class="badge">versiune</span> ${esc(c.from)} → <b>${esc(c.to)}</b>${c.notes ? `<div class="meta muted notes">${esc(c.notes)}</div>` : ''}`}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card panel" style="margin-top:14px" id="reviews"><h3>Recenzii recente ${q('Ultimele până la 100 de recenzii din această țară. „De ce se plâng” = cuvintele care apar în cele mai multe recenzii de 1–2 stele: ce ar putea face mai bine o aplicație nouă.')}</h3><div class="empty">Se încarcă recenziile…</div></div>`;
  state.ranks = r.ranks;
  drawEvo();
  bindApp();
  loadReviews(state.appId, r.country).catch((err) => { if ($('#reviews')) $('#reviews').innerHTML = `<h3>Recenzii recente</h3><div class="empty">Nu am putut încărca recenziile: ${esc(err.message)}</div>`; });
}

const EVO = [['downloads', 'Loc în topuri'], ['grossing', 'Topul încasărilor'], ['ratings', 'Rating-uri']];
function drawEvo() {
  const k = state.evo ?? 'downloads';
  const empty = { downloads: 'Aplicația n-a fost în topurile urmărite (top 100 pe categorii) în zilele colectate.',
    grossing: 'Aplicația n-a fost în topul încasărilor în zilele colectate (îl urmărim din 21 oct 2026).',
    ratings: 'Încă nu avem cifre zilnice pentru această aplicație (le adunăm din 21 oct 2026 pentru aplicațiile din topuri).' }[k];
  lineChart($('#rank-chart'), state.ranks[k], tip, k === 'ratings' ? { empty, auto: true } : { rank: true, empty });
}

const SUB_RE = /(month|week|year|annual|monat|woche|jahr|mois|semaine|annuel|mese|settiman|anno|mes\b|semana|año|premium|pro\b|plus|vip|subscription|abo)/i;
function iapHtml(d) {
  if (!d.iap) return '<div class="empty">Nu am putut citi pagina App Store a aplicației.</div>';
  const paid = d.price && /\d/.test(d.price);
  const price = paid ? `<p>Aplicația costă <b>${esc(d.price)}</b>.</p>` : '';
  if (!d.iap.has) return `${price}<div class="empty">Fără cumpărături în aplicație${paid ? '' : ' (gratuită: probabil trăiește din reclame)'}.</div>`;
  if (!d.iap.items.length) return `${price}<p>Are cumpărături în aplicație, dar Apple nu arată lista.</p>`;
  const subs = d.iap.items.filter((i) => SUB_RE.test(i.name));
  return `${price}${subs.length ? `<p><span class="badge money">abonament</span> ${subs.length} ${subs.length === 1 ? 'ofertă arată' : 'oferte arată'} a abonament sau premium.</p>` : ''}
    <table class="compact"><tbody>${d.iap.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num"><b>${esc(i.price)}</b></td></tr>`).join('')}</tbody></table>`;
}

function similarHtml(list, cc) {
  if (!list?.length) return '<div class="empty">App Store nu arată aplicații similare pentru ea.</div>';
  return `<ul class="apps">${list.map((a) => `<li><img src="${esc(a.icon)}" alt="" loading="lazy">
    <div><a data-app="${a.id}" data-app-country="${cc}" class="applink">${esc(a.name)}</a>
    <div class="meta">${esc(a.seller)} · ${a.ratings.toLocaleString('ro-RO')} rating-uri${a.rating ? ` · ${a.rating.toFixed(1)}★` : ''}</div></div></li>`).join('')}</ul>`;
}

async function loadReviews(id, cc) {
  const r = await api(`/api/reviews?id=${id}&country=${cc}`);
  const box = $('#reviews');
  if (!box || state.appId !== id) return;
  box.innerHTML = reviewsHtml(r, 'Recenzii recente', 'Nicio recenzie recentă în această țară.');
}

// Rezumatul recenziilor (o aplicatie sau toata nisa): distributia, de ce se plang, exemple.
function reviewsHtml(r, title, empty) {
  if (!r.count) return `<h3>${title}</h3><div class="empty">${empty}</div>`;
  const max = Math.max(...r.dist);
  const bars = [5, 4, 3, 2, 1].map((st) => `<div class="dist-row"><span>${st}★</span><span class="dist-bar"><i class="${st <= 2 ? 'bad' : ''}" style="width:${max ? (r.dist[st - 1] / max) * 100 : 0}%"></i></span><span class="muted">${r.dist[st - 1]}</span></div>`).join('');
  const rev = (x) => `<div class="review"><div><b>${'★'.repeat(x.stars)}<span class="off">${'★'.repeat(5 - x.stars)}</span></b> ${esc(x.title)} <span class="muted">· ${x.app ? `${esc(x.app)} · ` : ''}${esc(fmtDay(x.date))}${x.version ? ` · v${esc(x.version)}` : ''}</span></div><div class="muted">${esc(x.text.length > 320 ? `${x.text.slice(0, 320)}…` : x.text)}</div></div>`;
  return `<h3>${title} <span class="muted small">${r.count} din ${esc(fmtDay(r.from))} încoace · media ${r.avg}★</span></h3>
    <div class="grid2 reviews-grid">
      <div>${bars}
        <h4>De ce se plâng ${r.badCount ? `<span class="muted small">(${r.badCount} recenzii de 1–2★)</span>` : ''}</h4>
        ${r.complaints.length ? `<div class="words">${r.complaints.map((c) => `<span class="badge bad" data-tip="Apare în ${c.n} recenzii proaste">${esc(c.word)} · ${c.n}</span>`).join(' ')}</div>` : '<div class="muted">Prea puține recenzii proaste ca să iasă un tipar.</div>'}
        ${r.good.length ? `<h4>Ce le place</h4>${r.good.slice(0, 3).map(rev).join('')}` : ''}
      </div>
      <div><h4 style="margin-top:0">Recenzii proaste recente</h4>${r.bad.length ? r.bad.slice(0, 8).map(rev).join('') : '<div class="muted">Niciuna. Utilizatorii sunt mulțumiți.</div>'}</div>
    </div>`;
}

// Screenshot-urile: iPhone (sau iPad daca n-are), la rezolutie mare; click = marire.
const shotUrl = (u, px) => u.replace(/\/\d+x\d+bb\.\w+$/, `/${px}x${px}bb.jpg`);
function shotsCard(d) {
  const ipad = !d.screenshots.length;
  const list = ipad ? d.ipadScreenshots : d.screenshots;
  if (!list.length) return '<div class="card panel" style="margin-top:14px"><h3>Screenshot-uri</h3><div class="empty">Aplicația nu are screenshot-uri publice în această țară.</div></div>';
  state.shots = list;
  return `<div class="card panel" style="margin-top:14px">
    <h3>Screenshot-uri <span class="muted small">${list.length}${ipad ? ' · iPad' : ''} · click pentru mărire</span></h3>
    <div class="shots">${list.map((u, i) => `<img src="${esc(shotUrl(u, 800))}" data-shot="${i}" alt="Screenshot ${i + 1}" loading="lazy">`).join('')}</div></div>`;
}

function openShot(i) {
  const n = state.shots.length;
  i = (i + n) % n;
  let box = $('#lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.innerHTML = '<button class="lb-nav prev" aria-label="Înapoi">‹</button><img alt=""><button class="lb-nav next" aria-label="Înainte">›</button><div class="lb-count"></div>';
    document.body.append(box);
    box.addEventListener('click', (e) => {
      if (e.target.closest('.prev')) return openShot(Number(box.dataset.i) - 1);
      if (e.target.closest('.next')) return openShot(Number(box.dataset.i) + 1);
      closeShot();
    });
  }
  box.dataset.i = i;
  box.querySelector('img').src = shotUrl(state.shots[i], 2000);
  box.querySelector('.lb-count').textContent = `${i + 1} / ${n}`;
  box.hidden = false;
}
function closeShot() { const b = $('#lightbox'); if (b) b.hidden = true; }
document.addEventListener('keydown', (e) => {
  const b = $('#lightbox');
  if (!b || b.hidden) return;
  if (e.key === 'Escape') closeShot();
  if (e.key === 'ArrowRight') openShot(Number(b.dataset.i) + 1);
  if (e.key === 'ArrowLeft') openShot(Number(b.dataset.i) - 1);
});

function countryChips() {
  return ['US', 'GB', 'DE', 'FR', 'IT', 'ES'].map((c) => `<button type="button" class="chip ${c === state.appCountry ? 'on' : ''}" data-cc="${c}">${c}</button>`).join('');
}

function bindApp() {
  $('#back')?.addEventListener('click', () => history.back());
  document.querySelectorAll('.chip[data-cc]').forEach((b) => b.addEventListener('click', () => {
    state.appCountry = b.dataset.cc; remember(); renderApp().catch(showError);
  }));
  document.querySelectorAll('[data-evo]').forEach((b) => b.addEventListener('click', () => {
    state.evo = b.dataset.evo;
    document.querySelectorAll('[data-evo]').forEach((x) => x.classList.toggle('on', x === b));
    drawEvo();
  }));
  document.querySelectorAll('img[data-shot]').forEach((img) => img.addEventListener('click', () => openShot(Number(img.dataset.shot))));
  $('#kw-all')?.addEventListener('change', (e) => { state.appKwAll = e.target.checked; remember(); renderApp().catch(showError); });
}

// ---------- evenimente ----------
$('#nav').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a) return;
  navigate({ view: a.dataset.view, sort: null, text: '', from: null });
});
const onFilter = (fn) => (e) => { fn(e.target.value); remember(); renderView().then(remember).catch(showError); };
$('#f-country').addEventListener('change', onFilter((v) => { state.country = v; }));
$('#f-category').addEventListener('change', onFilter((v) => { state.category = v; }));
$('#f-period').addEventListener('change', onFilter((v) => { state.period = Number(v); }));
$('#f-origin').addEventListener('change', onFilter((v) => { state.origin = v; }));
$('#f-type').addEventListener('change', onFilter((v) => { state.chartType = v; }));
$('#f-source').addEventListener('change', onFilter((v) => { state.source = v; state.sort = null; }));
$('#f-who').addEventListener('change', onFilter((v) => { state.who = v; }));
$('#f-text').addEventListener('input', (e) => { state.text = e.target.value; renderTable(); remember(); });
$('#content').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const col = th.dataset.sort;
    state.sort = state.sort?.col === col ? { col, dir: -state.sort.dir } : { col, dir: COLS[col].num ? -1 : 1 };
    renderTable();
    return remember();
  }
  const t = e.target.closest('a[data-term]')?.dataset.term;
  if (t) return navigate({ term: t, view: 'search', from: state.view });
  const appEl = e.target.closest('a[data-app]');
  if (appEl) navigate({ view: 'app', appId: Number(appEl.dataset.app), appCountry: appEl.dataset.appCountry, appKwAll: false, from: state.view });
});
$('#csv').addEventListener('click', (e) => {
  if (!globalThis.TR_CSV) return;
  e.preventDefault();
  globalThis.TR_CSV($('#csv').href);
});
$('#refresh').addEventListener('click', async (e) => {
  const b = e.target; b.disabled = true; b.textContent = 'Se descarcă…';
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    if (r.warning) $('#notice').innerHTML = `<div class="notice">${esc(r.warning)}</div>`;
    viewCache.clear();
    await loadMeta(); await loadStatus(); await renderView(window.scrollY);
  } catch (err) { showError(err); } finally { b.disabled = false; b.textContent = 'Descarcă date noi'; }
});

function showError(err) {
  $('#content').innerHTML = `<div class="notice">Eroare: ${esc(err.message)}</div>`;
}

(async () => {
  await Promise.all([loadMeta(), loadStatus()]);
  history.replaceState(snapshot(), '');
  await renderView();
})().catch(showError);
