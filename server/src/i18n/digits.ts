/** Arabic-script digits and Hijri dates in values read from documents. */

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits as 0-9; Arabic separators as Latin ones. */
export function latinDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, '.')  // Arabic decimal separator
    .replace(/\u066C/g, ',')  // Arabic thousands separator
    .replace(/\u060C/g, ','); // Arabic comma
}

const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
function hijriParts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: parseInt(p.year, 10), m: parseInt(p.month, 10), d: parseInt(p.day, 10) };
}

/** A Hijri (Umm al-Qura) date as a Gregorian YYYY-MM-DD, or null when it isn't a real date. */
export function hijriToGregorian(y: number, m: number, d: number): string | null {
  if (!(y >= 1300 && y <= 1600 && m >= 1 && m <= 12 && d >= 1 && d <= 30)) return null;
  // Estimate, then walk to the exact day.
  const approx = Date.UTC(622, 6, 16) + ((y - 1) * 354.367 + (m - 1) * 29.53 + (d - 1)) * 86400000;
  const key = (h: { y: number; m: number; d: number }) => h.y * 10000 + h.m * 100 + h.d;
  const want = y * 10000 + m * 100 + d;
  let t = approx;
  for (let i = 0; i < 60; i++) {
    const k = key(hijriParts(new Date(t)));
    if (k === want) return new Date(t).toISOString().slice(0, 10);
    t += (k < want ? 1 : -1) * 86400000;
  }
  return null;
}

/** A value read from a document: Latin digits, and 'H:YYYY-MM-DD' Hijri dates turned into Gregorian. */
export function normaliseExtracted(v: string): string {
  const s = latinDigits(v).trim();
  const h = /^H:\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (h) return hijriToGregorian(+h[1], +h[2], +h[3]) ?? s;
  return s;
}
