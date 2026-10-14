/**
 * Dates in the supplier portal. In Arabic, dates are written with Arabic month names and the
 * Umm al-Qura Hijri date alongside — e.g. "14 أكتوبر 2026 (22 ربيع الآخر 1448 هـ)". Digits stay Western (0-9),
 * as on Gulf business documents.
 */
import { getLang, t } from './index';

const asDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s));

export function hijri(s?: string | null): string {
  if (!s) return '';
  const d = asDate(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-SA-u-ca-islamic-umalqura-nu-latn' : 'en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** Arabic: Gregorian with Arabic month names, plus the Hijri date. Other languages: null (use the normal formatter). */
export function arabicDate(s: string, withTime = false): string {
  const d = asDate(s);
  if (Number.isNaN(d.getTime())) return '—';
  const greg = new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  return withTime ? greg : `${greg} (${hijri(s)})`;
}

/** Under a date input: the same day in the Hijri calendar (Arabic portal only). */
export function HijriHint({ date }: { date?: string | null }) {
  if (getLang() !== 'ar' || !date) return null;
  return <span className="hijri">{t('date.hijri', { date: hijri(date) })}</span>;
}
