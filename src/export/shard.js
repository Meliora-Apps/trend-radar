// Impartirea cuvintelor si a app-urilor in fisiere (acelasi calcul in exportator si in browser).
export const TERM_SHARDS = 256;
export const APP_SHARDS = 512;

// FNV-1a pe 32 de biti.
export function shardOf(key, n) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % n;
}
