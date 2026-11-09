// Clientii Apple: sugestii (hints), cautare (iTunes Search), topuri (RSS), lookup.
import { HttpError, makeThrottle, makeRetry, makeCounter } from './net.js';

export const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IT', 'ES'];
export const STOREFRONTS = { US: 143441, GB: 143444, DE: 143443, FR: 143442, IT: 143450, ES: 143454 };
export const CHART_TYPES = ['topfreeapplications', 'toppaidapplications', 'topgrossingapplications'];
// Topurile de descarcari (fara incasari): pentru "cel mai bun loc" al unui app.
export const DOWNLOAD_TYPES = ['topfreeapplications', 'toppaidapplications'];
// Lansarile noi ale Apple (o lista pe tara, genul e ignorat de Apple).
export const NEW_FEEDS = ['newfreeapplications', 'newpaidapplications'];

const HINTS_URL = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=';

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (s) => s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
  (_, n, d, h) => (n ? XML_ENT[n] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));

// Raspunsul hints e un plist XML; luam doar <key>term</key><string>...</string>, in ordine.
export function parseHints(xml) {
  const out = [];
  const re = /<key>term<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (let m; (m = re.exec(xml));) {
    const t = decodeXml(m[1]).trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function parseSearch(json) {
  return (json.results ?? []).slice(0, 10).map((r) => ({
    id: r.trackId,
    name: r.trackName ?? '',
    seller: r.sellerName ?? r.artistName ?? '',
    genreId: Number(r.primaryGenreId),
    subgenreId: (r.genreIds ?? []).map(Number).find((g) => g >= 7000 && g < 8000) ?? null,
    ratings: r.userRatingCount ?? 0,
    stars: r.averageUserRating ?? null,
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : null,
    updated: r.currentVersionReleaseDate ? r.currentVersionReleaseDate.slice(0, 10) : null,
  }));
}

// Cautarea pentru precomenzi (src/collect/steps.js, UPCOMING_TERMS): toate rezultatele (pana la 200), cu locul
// in cautare; pastram doar app-urile cu data lansarii dupa `after` (inca la precomanda). `pub` = cele mai multe
// rating-uri ale unui app al aceluiasi editor din aceeasi cautare (cat de mare e editorul).
export function parseUpcoming(json, after) {
  const results = json.results ?? [];
  const pub = new Map();
  for (const r of results) {
    const k = r.artistId ?? r.sellerName;
    pub.set(k, Math.max(pub.get(k) ?? 0, r.userRatingCount ?? 0));
  }
  return results.map((r, i) => ({ r, position: i + 1 }))
    .filter(({ r }) => r.releaseDate && r.releaseDate.slice(0, 10) > after)
    .map(({ r, position }) => ({
      id: r.trackId, position, name: r.trackName ?? '', seller: r.sellerName ?? r.artistName ?? '',
      genreId: Number(r.primaryGenreId), releaseDate: r.releaseDate.slice(0, 10), price: r.price ?? 0,
      pub: pub.get(r.artistId ?? r.sellerName) ?? 0,
    }));
}

export function parseChart(json) {
  let e = json?.feed?.entry;
  if (!e) return [];
  if (!Array.isArray(e)) e = [e];
  return e.map((x, i) => ({
    rank: i + 1,
    id: Number(x.id?.attributes?.['im:id']),
    name: x['im:name']?.label ?? '',
    genreId: Number(x.category?.attributes?.['im:id']),
  }));
}

// Lookup in loturi: datele stabile (data lansarii etc.) + cifrele zilei (rating-uri, versiune, pret).
export function parseAppMeta(json) {
  return (json.results ?? []).filter((r) => r.trackId).map((r) => ({
    id: r.trackId,
    name: r.trackName ?? '',
    genreId: Number(r.primaryGenreId) || null,
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : null,
    seller: r.sellerName ?? r.artistName ?? '',
    ratings: r.userRatingCount ?? 0,
    ratingsCur: r.userRatingCountForCurrentVersion ?? 0,
    stars: r.averageUserRating == null ? null : Math.round(r.averageUserRating * 100) / 100,
    version: r.version ?? '',
    updated: r.currentVersionReleaseDate ? r.currentVersionReleaseDate.slice(0, 10) : null,
    price: r.price ?? 0,
    notes: r.releaseNotes ?? '',
  }));
}

export function parseLookup(json) {
  return (json.results ?? []).map((r) => ({
    id: r.trackId,
    name: r.trackName ?? '',
    icon: r.artworkUrl100 ?? r.artworkUrl60 ?? '',
    ratings: r.userRatingCount ?? 0,
    rating: r.averageUserRating ?? null,
    seller: r.sellerName ?? '',
    url: r.trackViewUrl ?? '',
  }));
}

// Metadata completa a unui app (iTunes Lookup).
export function parseAppDetail(r) {
  if (!r) return null;
  return {
    id: r.trackId, name: r.trackName ?? '', seller: r.sellerName ?? r.artistName ?? '',
    sellerUrl: r.artistViewUrl ?? '', url: r.trackViewUrl ?? '', bundleId: r.bundleId ?? '',
    icon: r.artworkUrl512 ?? r.artworkUrl100 ?? '', description: r.description ?? '',
    releaseNotes: r.releaseNotes ?? '', version: r.version ?? '',
    updated: r.currentVersionReleaseDate ?? null, released: r.releaseDate ?? null,
    price: r.formattedPrice ?? '', genres: r.genres ?? [], primaryGenreId: Number(r.primaryGenreId),
    rating: r.averageUserRating ?? null, ratings: r.userRatingCount ?? 0,
    ageRating: r.trackContentRating ?? r.contentAdvisoryRating ?? '',
    languages: r.languageCodesISO2A ?? [], sizeBytes: Number(r.fileSizeBytes) || null,
    minOs: r.minimumOsVersion ?? '', screenshots: r.screenshotUrls ?? [], ipadScreenshots: r.ipadScreenshotUrls ?? [],
  };
}

// Subtitlul nu e in Lookup: il luam din pagina web App Store (primul element "subtitle" = antetul app-ului).
export function parseSubtitle(html) {
  const m = /class="subtitle[^"]*"[^>]*>([^<]+)</.exec(html);
  return m ? decodeXml(m[1]).trim() : null;
}

// Cumparaturile din aplicatie (Apple arata primele ~10, cu pret): perechi nume / pret din "Informatii".
export function parseIap(html) {
  const out = [];
  const re = /<div class="text-pair[^"]*"><span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g;
  for (let m; (m = re.exec(html));) out.push({ name: decodeXml(m[1]).trim(), price: decodeXml(m[2]).replace(/\u00a0/g, ' ').trim() });
  return { has: /"hasInAppPurchases":true/.test(html) || out.length > 0, items: out };
}

// "Ti-ar mai placea" de pe pagina app-ului: app-urile pe care le cumpara aceiasi oameni (aceeasi nisa).
export function parseSimilar(html, selfId) {
  const start = html.indexOf('id="similarItems"');
  if (start < 0) return [];
  const end = html.indexOf('data-test-id="shelf-wrapper"', start + 50);
  const seg = html.slice(start, end > 0 ? end : undefined);
  const ids = [];
  for (const m of seg.matchAll(/\/app\/[^"/]*\/id(\d+)/g)) {
    const id = Number(m[1]);
    if (id !== Number(selfId) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 15);
}

// Recenziile recente (RSS, 50 pe pagina).
export function parseReviews(json) {
  let e = json?.feed?.entry ?? [];
  if (!Array.isArray(e)) e = [e];
  return e.filter((x) => x['im:rating']).map((x) => ({
    id: x.id?.label ?? '',
    stars: Number(x['im:rating'].label),
    title: x.title?.label ?? '',
    text: x.content?.label ?? '',
    version: x['im:version']?.label ?? '',
    date: (x.updated?.label ?? '').slice(0, 10),
  }));
}

// Throttle-uri separate: hints/RSS tolereaza ~50/min, iTunes Search ~20/min.
// iTunes Search limiteaza pe ADRESA, nu pe tara: cand mai multe tari lucreaza in paralel de pe acelasi calculator,
// le dam acelasi `searchThrottle` (altfel 6 tari x 15/min = 90/min si Apple raspunde 429, apoi 403).
export function makeAppleClient({
  fetchImpl = fetch,
  lightMs = 1200,
  searchMs = 4000,
  searchThrottle = null,
  retry = makeRetry(),
  counter = makeCounter(),
} = {}) {
  const light = makeThrottle(lightMs);
  const heavy = makeThrottle(searchMs);
  const search = searchThrottle ?? heavy;
  const call = (throttle, what, url, opts, parse) =>
    counter.track(() => retry(() => throttle(async () => {
      const res = await fetchImpl(url, opts);
      if (!res.ok) throw new HttpError(res.status, what);
      return parse(res);
    })));

  // Akamai tine raspunsurile search/lookup pana la 24h: fara asta, cifrele "de azi" pot fi de ieri
  // (iar rating-urile pe zi ar sari aiurea). Un parametru nou la fiecare cerere = raspuns proaspat.
  const fresh = () => `&_=${Date.now().toString(36)}`;
  return {
    counter,
    suggest(prefix, country) {
      const sf = STOREFRONTS[country];
      if (!sf) throw new Error(`Tara necunoscuta: ${country}`);
      return call(light, 'hints', HINTS_URL + encodeURIComponent(prefix),
        { headers: { 'X-Apple-Store-Front': `${sf},29` } }, async (r) => parseHints(await r.text()));
    },
    topApps(term, country) {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
        + `&country=${country.toLowerCase()}&media=software&entity=software&limit=10&lang=en_us${fresh()}`;
      return call(search, 'search', url, {}, async (r) => parseSearch(await r.json()));
    },
    // Locul unui app la un cuvant, in primele 200 de rezultate ale cautarii (null = nu e in primele 200).
    searchRank(term, country, id) {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
        + `&country=${country.toLowerCase()}&media=software&entity=software&limit=200&lang=en_us${fresh()}`;
      return call(search, 'search', url, {}, async (r) => {
        const ids = ((await r.json()).results ?? []).map((x) => x.trackId);
        const i = ids.indexOf(Number(id));
        return { position: i >= 0 ? i + 1 : null, total: ids.length };
      });
    },
    upcoming(term, country, after) {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
        + `&country=${country.toLowerCase()}&media=software&entity=software&limit=200&lang=en_us${fresh()}`;
      return call(search, 'search', url, {}, async (r) => parseUpcoming(await r.json(), after));
    },
    chart(country, type, genreId) {
      const url = `https://itunes.apple.com/${country.toLowerCase()}/rss/${type}/limit=100/genre=${genreId}/json`;
      return call(light, 'rss', url, {}, async (r) => parseChart(await r.json()));
    },
    newFeed(country, type) {
      const url = `https://itunes.apple.com/${country.toLowerCase()}/rss/${type}/limit=100/json`;
      return call(light, 'rss', url, {}, async (r) => parseChart(await r.json()));
    },
    async appDetail(id, country) {
      const url = `https://itunes.apple.com/lookup?id=${id}&country=${country.toLowerCase()}${fresh()}`;
      const detail = await call(heavy, 'lookup', url, {}, async (r) => parseAppDetail((await r.json()).results?.[0]));
      if (!detail) return null;
      try {
        const res = await fetchImpl(`https://apps.apple.com/${country.toLowerCase()}/app/id${id}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15' } });
        const html = res.ok ? await res.text() : '';
        detail.subtitle = html ? parseSubtitle(html) : null;
        detail.iap = html ? parseIap(html) : null;
        detail.similarIds = html ? parseSimilar(html, id) : [];
      } catch {
        // pagina web e optionala; restul metadatelor raman
        Object.assign(detail, { subtitle: null, iap: null, similarIds: [] });
      }
      return detail;
    },
    appMeta(ids, country) {
      const url = `https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${country.toLowerCase()}${fresh()}`;
      return call(heavy, 'lookup', url, {}, async (r) => parseAppMeta(await r.json()));
    },
    reviews(id, country, page = 1) {
      const url = `https://itunes.apple.com/${country.toLowerCase()}/rss/customerreviews/page=${page}/id=${id}/sortBy=mostRecent/json`;
      return call(light, 'reviews', url, {}, async (r) => parseReviews(await r.json()));
    },
    lookup(ids, country) {
      const url = `https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${country.toLowerCase()}`;
      return call(heavy, 'lookup', url, {}, async (r) => parseLookup(await r.json()));
    },
  };
}
