// Lista "Schimbari" (ce schimba aplicatiile), in exportul pentru site: din cele 6 variante (7/14/30 zile x toate
// app-urile / doar cele care fac bani, ~1/4 din export, rescrise zilnic) raman fisiere doar doua (CHANGE_FILES):
// cea implicita a interfetei (7 zile, doar cei care fac bani: mica, se deschide des) si cea completa (30 de zile,
// toate app-urile) cu `since` = ziua de la care incepe fiecare perioada, pe tari. Celelalte sunt filtre ale celei
// complete (pickChanges), facute in browser (web/remote-api.js), cu acelasi rezultat ca vederea (views.js).
export const CHANGE_PERIODS = [7, 14, 30];
export const CHANGES_SPAN = 30;
export const CHANGE_FILES = [[7, 'money'], [CHANGES_SPAN, 'all']];
export const isChangeFile = (p, who) => CHANGE_FILES.some(([fp, fw]) => fp === p && fw === who);

// `dates`: zilele cu cifre ale tarii (crescator), cel putin ultimele p + 1. Perioada de p zile = ultimele p zile
// cu cifre (schimbarile de pret se vad fata de ziua dinainte), deci incepe cu a p-a zi de la final.
export function sinceOf(dates, p) {
  const d = dates.slice(-(p + 1));
  return d.length >= 2 ? d[1] : null;
}

export const changesSince = (dates) => Object.fromEntries(CHANGE_PERIODS.map((p) => [p, sinceOf(dates, p)]));

// Randurile listei pe `p` zile (who = 'money': doar cele din topul incasarilor), din lista mai lunga.
export function pickChanges(rows, since, p, who = 'all') {
  return rows.filter((r) => {
    const from = since[r.country]?.[p];
    return from != null && r.date >= from && (who !== 'money' || r.grossRank != null);
  });
}
