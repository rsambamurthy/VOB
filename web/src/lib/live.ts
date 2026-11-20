/**
 * Live screens (sourcing auctions): load a view, then refresh it whenever the server says something changed
 * (server-sent events); fall back to polling if the stream can't be kept open. Also a countdown on server time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function useLive<T extends { serverTime?: string }>(viewPath: string | null, streamPath: string | null, pick: (r: any) => T | null = (r) => r) {
  const [data, setData] = useState<T | null>();
  const [error, setError] = useState<string>();
  const [offset, setOffset] = useState(0); // server time − browser time
  const [connected, setConnected] = useState(false);
  const pickRef = useRef(pick); pickRef.current = pick;
  const load = useCallback(async () => {
    if (!viewPath) return;
    const sent = Date.now();
    try {
      const r = pickRef.current(await api(viewPath));
      setData(r); setError(undefined);
      if (r?.serverTime) setOffset(new Date(r.serverTime).getTime() - (sent + Date.now()) / 2);
    } catch (e: any) { setError(e.message); }
  }, [viewPath]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!streamPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    // At most one refresh a second, however busy the auction (keeps within the API rate limit).
    let last = 0;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); load(); }, Math.max(150, last + 1000 - Date.now())); };
    const es = new EventSource(`/api${streamPath}`, { withCredentials: true });
    es.addEventListener('hello', () => { setConnected(true); if (poll) { clearInterval(poll); poll = undefined; } });
    es.addEventListener('update', soon);
    es.onerror = () => { setConnected(false); if (!poll) poll = setInterval(load, 5000); };
    return () => { es.close(); clearTimeout(timer); if (poll) clearInterval(poll); };
  }, [streamPath, load]);
  return { data, setData, error, reload: load, offset, connected };
}

/** Milliseconds left until `until` on the server clock, ticking every second. */
export function useCountdown(until: string | null | undefined, offset: number, onZero?: () => void) {
  const [left, setLeft] = useState<number | null>(null);
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
    if (!until) { setLeft(null); return; }
    const tick = () => {
      const ms = new Date(until).getTime() - (Date.now() + offset);
      setLeft(Math.max(0, ms));
      if (ms <= 0 && !fired.current) { fired.current = true; setTimeout(() => onZero?.(), 800); }
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [until, offset]); // eslint-disable-line react-hooks/exhaustive-deps
  return left;
}

export const clock = (ms: number | null) => {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${p(h)}:${p(m)}:${p(x)}` : `${p(h)}:${p(m)}:${p(x)}`;
};
