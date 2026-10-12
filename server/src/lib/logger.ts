import pino from 'pino';
import { createRequire } from 'node:module';
import { env } from './env.js';

/** Pretty logs in development when pino-pretty is installed; plain JSON otherwise (and always in production). */
function prettyAvailable() {
  if (env.isProd || env.isTest) return false;
  try { createRequire(import.meta.url).resolve('pino-pretty'); return true; } catch { return false; }
}

export const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.code'],
  ...(prettyAvailable() ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname', sync: true } } } : {}),
});
