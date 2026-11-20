/**
 * Word → PDF with LibreOffice (headless soffice, installed in the Docker image). Optional: when it isn't installed
 * (or OFFICE_CONVERTER=off) documents come out as Word only and toPdf answers null. Conversions run one at a time,
 * each with its own throw-away LibreOffice profile, and are killed after 60 seconds. No network is used.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

const CANDIDATES = [process.env.SOFFICE_PATH, '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'];
const binary = () => (process.env.OFFICE_CONVERTER === 'off' ? null : CANDIDATES.find((p) => p && existsSync(p)) ?? null);
export const pdfAvailable = () => !!binary();

let queue: Promise<unknown> = Promise.resolve();
/** Convert a .docx to PDF; null when no converter is available or the conversion fails (logged). */
export function toPdf(docx: Buffer): Promise<Buffer | null> {
  const run = queue.then(() => convert(docx), () => convert(docx));
  queue = run.catch(() => null);
  return run;
}
async function convert(docx: Buffer): Promise<Buffer | null> {
  const bin = binary();
  if (!bin) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vg-office-'));
  try {
    await writeFile(path.join(dir, 'in.docx'), docx);
    await new Promise<void>((resolve, reject) => {
      execFile(bin, [`-env:UserInstallation=file://${path.join(dir, 'profile').replace(/\\/g, '/')}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'in.docx')],
        { timeout: 60_000, env: { ...process.env, HOME: dir } }, (err) => (err ? reject(err) : resolve()));
    });
    return await readFile(path.join(dir, 'in.pdf'));
  } catch (err) {
    logger.error({ err }, 'Word to PDF conversion failed');
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
