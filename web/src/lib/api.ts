/** Small fetch wrapper. Staff and vendor sessions use separate tokens so both can be open in one browser. */
export type Session = 'staff' | 'vendor';
const KEY: Record<Session, string> = { staff: 'vo.staffToken', vendor: 'vo.vendorToken' };

export const tokens = {
  get: (s: Session) => { try { return localStorage.getItem(KEY[s]); } catch { return null; } },
  set: (s: Session, t: string) => { try { localStorage.setItem(KEY[s], t); } catch { /* ignore */ } },
  clear: (s: Session) => { try { localStorage.removeItem(KEY[s]); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; session?: Session } = {}): Promise<T> {
  const token = opts.session ? tokens.get(opts.session) : null;
  const isForm = opts.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && opts.session) tokens.clear(opts.session);
    throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`, json.details);
  }
  return json as T;
}

export function docUrl(id: string, session: Session) {
  return `/api/documents/${id}?token=${encodeURIComponent(tokens.get(session) ?? '')}`;
}

export function decodeToken(t: string | null): any {
  if (!t) return null;
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}
