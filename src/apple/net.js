// Ritm (throttle), reincercari si contorizare pentru apelurile catre Apple.

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, what) {
    super(`HTTP ${status} (${what})`);
    this.status = status;
  }
}

// Apelurile trec pe rand, cu minim intervalMs intre ele. O eroare NU blocheaza urmatoarele.
export function makeThrottle(intervalMs, { sleep = defaultSleep, now = Date.now } = {}) {
  let last = -Infinity;
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const wait = intervalMs - (now() - last);
      if (wait > 0) await sleep(wait);
      last = now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

// Ritmul comun al mai multor apelanti (in Convex: toate tarile unei bucati ies prin aceeasi adresa IP, iar Apple
// limiteaza pe adresa). Cererile pornesc la cel putin `interval` una de alta, fara sa se astepte intre ele.
// La 429 (slow): toti fac o pauza de `pauseMs`, iar intervalul creste (x1.5, pana la maxMs); fiecare raspuns bun
// (ok) il scade la loc incet (-2%), pana la minMs. Asa ritmul se aseaza singur sub limita Apple, in loc ca
// fiecare tara sa astepte separat 15 + 30 + 60 s pentru fiecare cerere respinsa.
// `startMs`: ritmul de la care porneste (ex. cel atins in bucata de colectare anterioara).
// `until`: sfarsitul bucatii de lucru; o cerere care ar porni mai tarziu nu mai asteapta (OutOfTime), ramane
// pentru bucata urmatoare (altfel, cu multi apelanti la rand si ritm rar, bucata ar trece de limita actiunii).
export function makePacer(minMs, { maxMs = minMs * 10, pauseMs = 20_000, startMs = minMs, until = Infinity, sleep = defaultSleep, now = Date.now } = {}) {
  let interval = Math.min(maxMs, Math.max(minMs, startMs || minMs));
  let next = 0;
  let pausedUntil = 0;
  let pauses = 0;
  return {
    async wait() {
      for (;;) {
        const t = now();
        const at = Math.max(t, next, pausedUntil);
        if (at > until) throw new OutOfTime();
        next = at + interval;
        if (at > t) await sleep(at - t);
        if (now() >= pausedUntil) return; // nicio pauza noua cat am asteptat
      }
    },
    slow() {
      interval = Math.min(maxMs, interval * 1.5);
      if (now() >= pausedUntil) pauses++;
      pausedUntil = Math.max(pausedUntil, now() + pauseMs);
    },
    ok() { interval = Math.max(minMs, interval * 0.98); },
    stats: () => ({ intervalMs: Math.round(interval), pauses }),
  };
}

// Cererea nu mai incape in bucata de lucru (vezi makePacer): nu e o eroare a cererii (nici nu a plecat).
export class OutOfTime extends Error {
  constructor() {
    super('timpul bucatii s-a terminat');
    this.outOfTime = true;
  }
}

const retryable = (err) => !err.outOfTime && (!(err instanceof HttpError) || err.status === 429 || err.status >= 500);

// La 429/5xx/eroare de retea: pauza 30s, 60s, 120s... (max 10 min), maxim `retries` reincercari.
// `rateLimitDelayMs`: pauza dupa un 429 (implicit ca la celelalte); 0 cand un pacer comun face deja pauza.
export function makeRetry({ retries = 5, baseDelayMs = 30_000, maxDelayMs = 600_000, rateLimitDelayMs = null, sleep = defaultSleep, log = () => {} } = {}) {
  return async (fn) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!retryable(err) || attempt >= retries) throw err;
        const delay = err.status === 429 && rateLimitDelayMs != null ? rateLimitDelayMs : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        if (delay > 0) {
          log(`  reincerc in ${Math.round(delay / 1000)}s dupa: ${err.message}`);
          await sleep(delay);
        }
      }
    }
  };
}

// O cerere care nu raspunde in `ms` e anulata (altfel ar tine pe loc o tara pana la sfarsitul bucatii).
export class TimeoutError extends Error {
  constructor(ms, what) {
    super(`fara raspuns in ${Math.round(ms / 1000)}s (${what})`);
  }
}
export async function withTimeout(ms, what, fn) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ac?.abort(); reject(new TimeoutError(ms, what)); }, ms);
  });
  try {
    return await Promise.race([fn(ac?.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeCounter() {
  const stats = { requests: 0, failures: 0 };
  return {
    stats,
    async track(fn) {
      stats.requests++;
      try {
        return await fn();
      } catch (err) {
        if (err.outOfTime) stats.requests--; // cererea nici n-a plecat
        else stats.failures++;
        throw err;
      }
    },
    failureRate: () => (stats.requests ? stats.failures / stats.requests : 0),
    // Daca Apple ne blocheaza serios, ne oprim in loc sa ardem ore intregi in reincercari.
    tooManyFailures: (min = 50, max = 0.1) => stats.requests >= min && stats.failures / stats.requests > max,
  };
}
