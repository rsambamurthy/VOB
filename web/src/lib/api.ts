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
  if (!res.ok) {
    // No JSON body on a 5xx = the dev proxy couldn't reach the API (it isn't running or crashed on start-up).
    const unreachable = res.status >= 500 && !json.error;
    // The page knows an endpoint the running API doesn't: the API is an older build that wasn't restarted.
    if (json.code === 'NO_ROUTE') throw new ApiError(404, 'The API server is running older code than this page. Stop the API window (Ctrl+C) and start it again, then refresh.', undefined, 'NO_ROUTE');
    throw new ApiError(res.status, json.error ?? (unreachable ? 'Can’t reach the server. Check the terminal running “npm run dev” — the [api] lines will show why it stopped.' : `Request failed (${res.status})`), json.details, json.code);
  }
  return json as T;
}

export const docUrl = (id: string) => `/api/documents/${id}`;

/** Remember the last workspace used on this device (convenience only). */
export const lastWorkspace = {
  get: () => { try { return localStorage.getItem('vg.workspace') ?? ''; } catch { return ''; } },
  set: (w: string) => { try { localStorage.setItem('vg.workspace', w); } catch { /* ignore */ } },
};
