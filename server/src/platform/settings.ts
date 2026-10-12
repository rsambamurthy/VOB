import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';

/** The single platform settings row, created with defaults on first use. */
export async function getPlatformSettings() {
  const row = await db.query.platformSettings.findFirst({ where: eq(schema.platformSettings.id, 'default') });
  if (row) return row;
  await db.insert(schema.platformSettings).values({ id: 'default' }).onConflictDoNothing();
  return (await db.query.platformSettings.findFirst({ where: eq(schema.platformSettings.id, 'default') }))!;
}
