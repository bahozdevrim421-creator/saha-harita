// CSV text for Excel. Pure functions first (tested under Node); csvIndir() is the browser download.
// UTF-8 with a BOM so Excel shows Turkish characters correctly. Fields are separated by ";" because
// Excel in Turkish locales splits ";" files into columns; a comma file opens as one column there.
// Line ends are CRLF, as Excel writes them.

export const CSV_BOM = '﻿';
export const CSV_AYRAC = ';';

/** One CSV cell. null and undefined become empty. Cells with ;, quotes or line breaks are quoted. */
export function csvHucre(value, ayrac = CSV_AYRAC) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const needsQuotes = s.includes(ayrac) || /["\r\n]/.test(s);
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Whole CSV file as text: BOM, header row from columns [{ baslik, alan }], one line per row object.
 * Rows are plain objects; alan selects the value.
 */
export function csvMetni(kolonlar, satirlar, { ayrac = CSV_AYRAC } = {}) {
  const header = kolonlar.map((k) => csvHucre(k.baslik, ayrac)).join(ayrac);
  const lines = satirlar.map((r) => kolonlar.map((k) => csvHucre(r[k.alan], ayrac)).join(ayrac));
  return `${CSV_BOM}${[header, ...lines].join('\r\n')}\r\n`;
}

/** File name such as "isletmeler-2026-11-24.csv". */
export function csvDosyaAdi(onek, gun) {
  return `${onek}-${gun}.csv`;
}

/** Starts a browser download of CSV text. Does nothing outside a browser. */
export function csvIndir(metin, dosyaAdi) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([metin], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = dosyaAdi;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
