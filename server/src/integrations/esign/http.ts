/** Small HTTP helper for the e-signature connectors: JSON, form and multipart bodies, 30-second timeout, readable errors. */
import { ProviderError } from './types.js';

export interface HttpOpts { headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; multipart?: FormData; raw?: boolean }
export async function http(provider: string, method: string, url: string, o: HttpOpts = {}) {
  const headers: Record<string, string> = { Accept: o.raw ? '*/*' : 'application/json', ...(o.headers ?? {}) };
  let body: BodyInit | undefined;
  if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
  else if (o.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  else if (o.multipart) body = o.multipart;
  let res: Response;
  try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new ProviderError(provider, `couldn’t reach the service (${(e as Error).message})`); }
  if (o.raw && res.ok) return { status: res.status, json: null as any, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = json?.message ?? json?.error_description ?? json?.error?.message ?? json?.errorCode ?? json?.error ?? text.slice(0, 200) ?? res.statusText;
    throw new ProviderError(provider, `${typeof msg === 'string' ? msg : JSON.stringify(msg)} (HTTP ${res.status})`, res.status);
  }
  return { status: res.status, json, buffer: Buffer.from(text), headers: res.headers };
}
export const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
export const header = (h: Record<string, string | string[] | undefined>, name: string) => { const v = h[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
/** Tokens are cached per credential set until shortly before they expire. */
const tokens = new Map<string, { token: string; until: number }>();
export async function cachedToken(key: string, get: () => Promise<{ token: string; expiresIn: number }>) {
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const t = await get();
  tokens.set(key, { token: t.token, until: Date.now() + Math.max(60, t.expiresIn - 120) * 1000 });
  return t.token;
}
export const forgetTokens = () => tokens.clear();
