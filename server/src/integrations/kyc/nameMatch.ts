/** How alike two business names are, 0–100, ignoring "Pvt Ltd", "M/s", punctuation and word order. */
const NOISE = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'co', 'company', 'corp', 'corporation', 'the', 'm', 's', 'ms', 'and', 'of', 'india', 'gmbh', 'plc', 'opc']);

export function normaliseName(s: string) {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w)).sort().join(' ');
}

export function nameMatch(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const x = normaliseName(a), y = normaliseName(b);
  if (!x || !y) return null;
  if (x === y) return 100;
  const grams = (s: string) => { const g = new Map<string, number>(); const t = s.replace(/ /g, ''); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const gx = grams(x), gy = grams(y);
  let inter = 0, total = 0;
  for (const [k, n] of gx) { inter += Math.min(n, gy.get(k) ?? 0); total += n; }
  for (const n of gy.values()) total += n;
  return total ? Math.round((2 * inter / total) * 100) : 0;
}
