/** Create the database named in DATABASE_URL if it doesn't exist yet (lets VendorGate share a Postgres server with other apps, in its own database). */
import pg from 'pg';

export async function ensureDatabase(url = process.env.DATABASE_URL!) {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unusual database name "${name}" — create it by hand`);
  const admin = new URL(u); admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString(), ssl: u.searchParams.get('sslmode') === 'require' ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    if (!(await c.query('select 1 from pg_database where datname = $1', [name])).rowCount) {
      await c.query(`create database "${name}"`);
      console.log(`[startup] created database "${name}"`);
    }
  } finally { await c.end(); }
}
