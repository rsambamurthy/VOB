/**
 * Deadlines that can skip the weekend. A workspace with "skip weekends" on (default for Gulf
 * workspaces: Friday–Saturday) counts approval deadlines and auto-accept days on working days only.
 * Weekdays are judged in the workspace's own time zone.
 */
import type { Tenant } from '../db/schema.js';
import { packFor } from '../countries/registry.js';

export interface WorkCalendar { weekend: number[]; timeZone: string }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The calendar a workspace's deadlines follow; no weekend when the workspace counts every day. */
export function calendarFor(t: Pick<Tenant, 'country' | 'settings'> | null | undefined): WorkCalendar {
  const p = packFor(t?.country);
  const tz = p.timeZone ?? 'UTC';
  return { weekend: t?.settings?.skipWeekends ? (p.weekend ?? []) : [], timeZone: tz };
}

const weekdayFmt = new Map<string, Intl.DateTimeFormat>();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function weekdayIn(d: Date, timeZone: string) {
  let f = weekdayFmt.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }); weekdayFmt.set(timeZone, f); }
  return DAYS.indexOf(f.format(d));
}

const isOff = (d: Date, c: WorkCalendar) => c.weekend.includes(weekdayIn(d, c.timeZone));

/** `hours` from `from`, not counting weekend hours. */
export function addWorkingHours(from: Date, hours: number, c: WorkCalendar): Date {
  if (!c.weekend.length) return new Date(from.getTime() + hours * HOUR);
  let t = from.getTime();
  let left = hours;
  // Starting on a weekend: the clock starts when the weekend ends.
  for (let guard = 0; isOff(new Date(t), c) && guard < 24 * 7; guard++) t += HOUR;
  for (let guard = 0; left > 0 && guard < 24 * 400; guard++) {
    t += HOUR;
    if (!isOff(new Date(t - 1), c)) left--;
  }
  return new Date(t);
}

/** `days` from `from`, counting working days only. */
export function addWorkingDays(from: Date, days: number, c: WorkCalendar): Date {
  if (!c.weekend.length) return new Date(from.getTime() + days * DAY);
  let t = from.getTime();
  let left = days;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    t += DAY;
    if (!isOff(new Date(t), c)) left--;
  }
  return new Date(t);
}

/** "Thu, 15 Oct 2026, 10:30 AST" in the workspace's own zone and locale. */
export function formatDeadline(d: Date, t: Pick<Tenant, 'country'> | null | undefined) {
  const p = packFor(t?.country);
  return `${d.toLocaleString(p.locale ?? 'en-GB', { timeZone: p.timeZone ?? 'UTC', dateStyle: 'medium', timeStyle: 'short' })} ${p.timeZoneLabel ?? ''}`.trim();
}
export function formatDay(d: Date, t: Pick<Tenant, 'country'> | null | undefined) {
  const p = packFor(t?.country);
  return d.toLocaleDateString(p.locale ?? 'en-GB', { timeZone: p.timeZone ?? 'UTC', day: 'numeric', month: 'long' });
}
