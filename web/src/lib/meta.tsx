import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { OnboardingConfig } from './types';

/** Fixed lookups (no API call needed). */
export const VENDOR_TYPES = [
  { value: 'DOMESTIC', label: 'Domestic' },
  { value: 'IMPORT', label: 'Import (foreign)' },
  { value: 'GOVERNMENT', label: 'Government' },
];

interface ConfigValue { config: OnboardingConfig | null; version: number; reload: () => Promise<void> }
const Ctx = createContext<ConfigValue>({ config: null, version: 0, reload: async () => {} });

/** The workspace's published onboarding configuration (staff side). */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ config: OnboardingConfig | null; version: number }>({ config: null, version: 0 });
  const reload = useCallback(async () => {
    const r = await api<{ version: number; config: OnboardingConfig }>('/config');
    setState({ config: r.config, version: r.version });
  }, []);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  return <Ctx.Provider value={{ ...state, reload }}>{children}</Ctx.Provider>;
}

export const useConfig = () => useContext(Ctx);
