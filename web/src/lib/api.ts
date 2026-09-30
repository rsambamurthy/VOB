/**
 * Fetch wrapper. Auth is by httpOnly session cookies set by the API; every request carries
 * X-Requested-With (the server's CSRF check).
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown, public code?: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fetch', ...(opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`, json.details, json.code);
  return json as T;
}

export const docUrl = (id: string) => `/api/documents/${id}`;

/** Remember the last workspace used on this device (convenience only). */
export const lastWorkspace = {
  get: () => { try { return localStorage.getItem('vg.workspace') ?? ''; } catch { return ''; } },
  set: (w: string) => { try { localStorage.setItem('vg.workspace', w); } catch { /* ignore */ } },
};
