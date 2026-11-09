// De unde "vine" un cuvant-cheie pentru un app: titlu, subtitlu sau (probabil) campul ascuns de keywords.
// Apple indexeaza titlul, subtitlul si campul ascuns de 100 caractere (nu descrierea).

export const words = (s) => (s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Potrivire toleranta la plural simplu (friend/friends, game/games).
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const has = (set, w) => set.has(stem(w));

// 'title' | 'subtitle' | 'both' | 'partial' | 'hidden'
export function keywordSource(term, title, subtitle) {
  const tw = new Set(words(title).map(stem));
  const sw = new Set(words(subtitle).map(stem));
  const kw = words(term);
  if (!kw.length) return 'hidden';
  if (kw.every((w) => has(tw, w))) return 'title';
  if (kw.every((w) => has(sw, w))) return 'subtitle';
  if (kw.every((w) => has(tw, w) || has(sw, w))) return 'both';
  if (kw.some((w) => has(tw, w) || has(sw, w))) return 'partial';
  return 'hidden';
}

// Cuvinte de legatura (EN/DE/FR/IT/ES): nu le cautam singure si nu incep/termina o expresie.
const STOP = new Set(('a an and the of for to in on at by with your my our from or app apps ' +
  'und der die das für mit von zu im am ein eine dein ' +
  'et le la les des du de pour avec en au aux un une ton votre ' +
  'e il lo gli di da per con su un una il tuo ' +
  'y el los las del para con en un una tu').split(' '));

// Expresiile de 1..3 cuvinte dintr-un text (fara cuvinte de legatura la capete), cele lungi primele.
// Nu trec peste semnele de despartire: "Mock Tests & Hazard Perception" -> "mock tests", "hazard perception".
function phrases(text) {
  const parts = (text ?? '').split(/\s[&|+\-–—]\s|[:,;|()/!?·•]/).map(words).filter((w) => w.length);
  const out = [];
  for (let n = 3; n >= 1; n--) {
    for (const w of parts) {
      for (let i = 0; i + n <= w.length; i++) {
        const p = w.slice(i, i + n);
        if (STOP.has(p[0]) || STOP.has(p[p.length - 1])) continue;
        out.push(p.join(' '));
      }
    }
  }
  return out;
}

// Ce cuvinte verificam pentru "Verifica acum" pe pagina unui app: cele unde il stim deja in top 10, numele
// intreg, expresiile din titlu, apoi din subtitlu, apoi sugestiile App Store pentru cuvintele din nume
// (acolo apar si cuvintele din campul ascuns). Locul real il da apoi cautarea.
export function checkCandidates({ name, subtitle, known = [], hints = [], max = 40 }) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const k = words(t).join(' ');
    if (!k || seen.has(k) || (!k.includes(' ') && STOP.has(k))) return;
    seen.add(k);
    out.push(k);
  };
  known.forEach(add);
  const full = words(name);
  if (full.length > 1 && full.length <= 6) add(full.join(' '));
  phrases(name).forEach(add);
  phrases(subtitle).forEach(add);
  hints.forEach(add);
  return out.slice(0, max);
}

// Pentru ce cerem sugestii App Store la "Verifica acum": perechile de cuvinte din nume (un cuvant generic
// singur, ca "learn", aduce zgomot: "learn spanish"). Daca numele nu are perechi, cuvintele lui.
export function hintSeeds(name, max = 3) {
  const all = phrases(name);
  const pairs = all.filter((p) => p.split(' ').length === 2);
  return (pairs.length ? pairs : all.filter((p) => !p.includes(' '))).slice(0, max);
}

// Sugestiile App Store merg pe inceput de text ("learn uk" -> "learn ukulele"): pastram doar ce incepe cu
// perechea ca si cuvinte intregi.
export function hintsFor(seed, hints) {
  const k = words(seed).join(' ');
  return hints.filter((h) => { const w = words(h).join(' '); return w === k || w.startsWith(`${k} `); });
}

// Ce a scris omul in "Cauta aplicatie": link App Store (cu tara din link), id (id123 sau doar cifre) sau nume.
export function parseAppQuery(q) {
  const t = (q ?? '').trim();
  if (!t) return null;
  const link = t.match(/apps\.apple\.com\/([a-z]{2})\/.*?id(\d{5,})/i);
  if (link) return { id: Number(link[2]), country: link[1].toUpperCase() };
  const id = t.match(/^(?:id)?(\d{6,})$/i);
  if (id) return { id: Number(id[1]), country: null };
  return { term: t.toLowerCase().replace(/\s+/g, ' ') };
}
