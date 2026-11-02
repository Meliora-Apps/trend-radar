// Exportul CSV al listelor de cuvinte (folosit de serverul local si de varianta online).
const CSV_COLS = ['country', 'term', 'score', 'delta', 'then', 'categoryName', 'subgenreName', 'difficulty', 'origin', 'confirmed', 'seenDays', 'ofDays', 'firstSeen'];
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (rows) => [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(','))].join('\n');
