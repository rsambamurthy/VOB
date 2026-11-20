/**
 * Human-readable numbers, unique per workspace — one implementation for every module.
 *   yearly:   PREFIX-2026-0001 (sourcing events, contracts) — restarts each year
 *   running:  PREFIX-00001     (contract parties)
 * Called inside a transaction; an advisory lock per workspace + series stops two requests taking the same number.
 */
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { db } from './db.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
interface Series { table: PgTable; tenantCol: PgColumn; numberCol: PgColumn }

async function next(tx: Tx, s: Series, tenantId: string, stem: string, digits: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${stem}`}))`);
  // Only numbers of exactly this shape count, so a code typed another way can't break the series.
  const [last] = await tx.select({ n: s.numberCol }).from(s.table)
    .where(and(eq(s.tenantCol, tenantId), like(s.numberCol, `${stem}%`), sql`${s.numberCol} ~ ${`^${stem.replace(/[-]/g, '\\-')}[0-9]+$`}`))
    .orderBy(desc(sql`length(${s.numberCol})`), desc(s.numberCol)).limit(1);
  const n = last ? Number(String(last.n).slice(stem.length)) + 1 : 1;
  return `${stem}${String(n).padStart(digits, '0')}`;
}

export const nextYearlyNumber = (tx: Tx, s: Series, tenantId: string, prefix: string) => next(tx, s, tenantId, `${prefix}-${new Date().getUTCFullYear()}-`, 4);
export const nextRunningCode = (tx: Tx, s: Series, tenantId: string, prefix: string) => next(tx, s, tenantId, `${prefix}-`, 5);
