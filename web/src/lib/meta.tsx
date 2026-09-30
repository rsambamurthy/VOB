import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Condition, Meta, Profile } from './types';

const Ctx = createContext<Meta | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => { api<Meta>('/meta').then(setMeta).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="center-page"><div className="card pad"><h2>Cannot reach the server</h2><p className="muted">{error}. Is the API running on port 4000?</p></div></div>;
  if (!meta) return <div className="center-page"><div className="spinner" /></div>;
  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export const useMeta = () => useContext(Ctx)!;

/** Mirror of the server's condition logic, used to show / hide fields as the vendor types. */
export function conditionHolds(c: Condition | undefined, profile: Profile): boolean {
  if (!c) return true;
  const [s, f] = c.field.split('.');
  const raw = profile?.[s]?.[f];
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (c.equals !== undefined) return v === c.equals;
  if (c.notEquals !== undefined) return v !== '' && v !== c.notEquals;
  if (c.in) return c.in.includes(v);
  return true;
}

export function isRequired(req: boolean | Condition | undefined, profile: Profile) {
  if (req === true) return true;
  if (!req) return false;
  return conditionHolds(req, profile);
}
