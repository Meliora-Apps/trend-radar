// Copia bazei unei tari, pastrata in Convex intre calcule (state db/<CC>: bucatile in storage + value).
// Pasul tarii o descarca la fiecare calcul, deci marimea ei e cel mai mare cost zilnic de trafic. Copia e:
//  - compacta: VACUUM INTO (fara paginile libere), fara indexurile secundare (openDb le reface la deschidere,
//    din SCHEMA: CREATE INDEX IF NOT EXISTS), iar paginile lor eliberate sunt scrise cu zero (secure_delete);
//  - brotli 9 (fereastra 22: memorie putina, ~+75 MB fata de gzip), nu gzip 4.
// Pe baza ES (107 MB): 29,3 MB gzip 4 -> 11,8 MB. Copiile vechi (gzip, fara `format`) se citesc in continuare.
// Copia se salveaza doar o data la COPY_DAYS zile (sau cand e refacuta / in formatul vechi): intre timp, pasul
// tarii aduce copia la zi din arhiva (fisierele zilnice inca neimportate), cu acelasi rezultat (vezi copyDue).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { constants, createBrotliCompress, createBrotliDecompress, createGunzip } from 'node:zlib';
import { diffDays } from '../util/dates.js';

export const COPY_FORMAT = 'br';
// O copie mai noua de atat nu se rescrie. Costul zilnic: copia rescrisa (~1/N) + fisierele zilnice reimportate
// (in medie (N-1)/2 zile); minimul e pe la 7 zile.
export const COPY_DAYS = 7;

// Copia compacta a bazei deschise `db`, in fisierul `out` (nu exista inca).
export function compactCopy(db, out) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.rmSync(out, { force: true });
  db.prepare('VACUUM INTO ?').run(out);
  const copy = new DatabaseSync(out);
  try {
    copy.exec('PRAGMA secure_delete = ON');
    const indexes = copy.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL").all();
    for (const { name } of indexes) copy.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
  } finally {
    copy.close();
  }
  return fs.statSync(out).size;
}

export const packStream = () => createBrotliCompress({
  params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 22 },
});

// Dezarhivarea unei copii, dupa `format` din value (copiile vechi: gzip).
export const unpackStream = (format) => (format === COPY_FORMAT ? createBrotliDecompress() : createGunzip());

// Ce se scrie in value la salvare: marimea bazei, formatul, ultima zi din baza (pentru copyDue).
export const copyValue = (bytes, latest) => ({ bytes, format: COPY_FORMAT, latest });

// Trebuie rescrisa copia? Da, daca baza a fost refacuta din arhiva (fara copie sau cu una stricata), daca copia e
// in formatul vechi sau nu stim ziua ei, ori daca baza a ajuns la COPY_DAYS zile dupa ea.
export function copyDue(value, latest, { restored }) {
  if (!restored || value?.format !== COPY_FORMAT || !value.latest) return true;
  return latest != null && diffDays(latest, value.latest) >= COPY_DAYS;
}
