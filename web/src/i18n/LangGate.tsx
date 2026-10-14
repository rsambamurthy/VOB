import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { setLang } from './index';

const SUPPLIER = /^\/(vendor|s|onboard)(\/|$)/;

/** Staff and platform screens are English only; supplier screens set their own language. */
export function LangGate() {
  const { pathname } = useLocation();
  useEffect(() => { if (!SUPPLIER.test(pathname)) setLang('en'); }, [pathname]);
  return null;
}
