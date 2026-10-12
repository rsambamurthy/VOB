/**
 * Help search: tolerant of typos, plurals and everyday words ("cant login" finds Signing in).
 * Small and dependency-free; the article set is a few dozen items, so a linear scan is instant.
 */
import type { HelpArticle } from './articles';

/** Everyday words → the words the articles use. */
const SYNONYMS: Record<string, string[]> = {
  login: ['sign', 'signin'], logon: ['sign'], log: ['sign'], signin: ['sign'], logout: ['sign', 'out'],
  mfa: ['2fa', 'two', 'factor'], '2fa': ['two', 'factor', 'authenticator'], otp: ['code'], pin: ['code'],
  supplier: ['vendor'], suppliers: ['vendor'], vendor: ['supplier'], seller: ['vendor'],
  delete: ['erase', 'remove'], remove: ['delete', 'disable'], deactivate: ['disable'],
  approver: ['approve', 'approval'], approve: ['approval'], authorise: ['approve'], authorize: ['approve'],
  workflow: ['approval', 'flow', 'level'], sla: ['deadline'], escalation: ['deadline', 'overdue'],
  export: ['download', 'excel', 'erp'], download: ['export', 'excel'], excel: ['report', 'download'],
  bank: ['account'], gst: ['gstin'], tin: ['tax'], kyc: ['verification', 'verify'],
  holiday: ['out', 'office', 'delegate'], leave: ['out', 'office', 'delegate'], vacation: ['out', 'office'],
  permission: ['role'], access: ['role', 'permission'], admin: ['administrator'],
  hold: ['block'], suspend: ['block', 'suspended'], stop: ['block'],
  edit: ['change'], update: ['change'], modify: ['change'],
  email: ['mail'], mail: ['email'], spam: ['junk'], gdpr: ['privacy', 'dpdp'],
  plan: ['limit', 'trial'], upgrade: ['plan'], tenant: ['workspace'],
};
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'i', 'my', 'is', 'it', 'do', 'does', 'how', 'what', 'why', 'can', 'cant', 'cannot', 'not', 'be', 'with', 'from', 'this', 'that', 'where', 'when', 'who', 'you', 'your', 'me', 'we', 'am', 'are', 'was', 'get']);

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
export const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** Edit distance where a swapped pair of letters counts as one typo ("bnak" → "bank"). */
function close(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowBest = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      rowBest = Math.min(rowBest, v);
    }
    if (rowBest > max) return false;
  }
  return d[a.length][b.length] <= max;
}

/** Strips help markup so search only sees words. */
const plain = (body: string) => body.replace(/!\[[^\]]*\]\([^)]*\)|@video\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, ' ');

interface Indexed { a: HelpArticle; fields: { words: Set<string>; stems: string[]; weight: number }[] }
const cache = new WeakMap<HelpArticle, Indexed>();
function index(a: HelpArticle): Indexed {
  let ix = cache.get(a);
  if (!ix) {
    const field = (text: string, weight: number) => { const w = tokens(text); return { words: new Set(w), stems: [...new Set(w.map(stem))], weight }; };
    ix = { a, fields: [field(a.title, 10), field(a.keywords ?? '', 6), field(a.summary, 4), field(plain(a.body), 1.5)] };
    cache.set(a, ix);
  }
  return ix;
}

/** Score of one query word in one field: exact > stem > prefix > typo. */
function wordScore(q: string, f: Indexed['fields'][number]) {
  if (f.words.has(q)) return 1;
  const qs = stem(q);
  if (f.stems.includes(qs)) return 0.9;
  if (q.length >= 3 && f.stems.some((s) => s.startsWith(qs))) return 0.7;
  if (q.length >= 4 && f.stems.some((s) => close(qs, s, q.length >= 7 ? 2 : 1))) return 0.55;
  return 0;
}

export function searchHelp(query: string, articles: HelpArticle[]) {
  const q = tokens(query);
  if (!q.length) return [];
  const results: { a: HelpArticle; score: number }[] = [];
  for (const a of articles) {
    const ix = index(a);
    let score = 0, matched = 0;
    for (const w of q) {
      const alts = [w, ...(SYNONYMS[w] ?? [])];
      let best = 0;
      for (const f of ix.fields) for (const alt of alts) best = Math.max(best, wordScore(alt, f) * f.weight * (alt === w ? 1 : 0.6));
      if (best > 0) matched++;
      score += best;
    }
    // Every word should count: articles matching all of them rank first.
    if (matched) results.push({ a, score: score * (matched / q.length) ** 2 + (norm(a.title).includes(norm(query.trim())) ? 8 : 0) + (norm(a.title).startsWith(norm(query.trim())) ? 4 : 0) });
  }
  return results.sort((x, y) => y.score - x.score).filter((r, i, all) => r.score >= all[0].score * 0.15).slice(0, 12);
}
