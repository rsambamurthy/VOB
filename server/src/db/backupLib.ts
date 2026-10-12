/**
 * Database dump / restore. Uses pg_dump / pg_restore when they are installed (production image,
 * Linux servers); otherwise, for local development on Windows/macOS, runs them inside the
 * docker-compose "db" container.
 */
import { spawn, spawnSync } from 'node:child_process';
import { env } from '../lib/env.js';

const hasTool = (bin: string) => spawnSync(bin, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

function run(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', env: process.env });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on('data', (b) => out.push(b));
    p.stderr.on('data', (b) => err.push(b));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} failed (${code}): ${Buffer.concat(err).toString().trim().slice(0, 800)}`))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/** Where the dump runs: local tools, or the docker-compose db container. */
export function backupMode(): 'tools' | 'docker' {
  if (process.env.BACKUP_VIA === 'docker') return 'docker';
  if (process.env.BACKUP_VIA === 'tools' || hasTool('pg_dump')) return 'tools';
  return 'docker';
}

function dockerDb() {
  const u = new URL(env.databaseUrl);
  return { user: decodeURIComponent(u.username), db: u.pathname.slice(1) };
}

/** Custom-format dump (compressed; restorable table by table). */
export async function dumpDatabase(): Promise<Buffer> {
  if (backupMode() === 'tools') return run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--dbname=${env.databaseUrl}`]);
  const { user, db } = dockerDb();
  return run('docker', ['compose', 'exec', '-T', 'db', 'pg_dump', '--format=custom', '--no-owner', '--no-privileges', '-U', user, '-d', db]);
}

/** Replaces the current database contents with the dump. */
export async function restoreDatabase(dump: Buffer) {
  const common = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction'];
  if (backupMode() === 'tools') return run('pg_restore', [...common, `--dbname=${env.databaseUrl}`], dump);
  const { user, db } = dockerDb();
  return run('docker', ['compose', 'exec', '-T', 'db', 'pg_restore', ...common, '-U', user, '-d', db], dump);
}
