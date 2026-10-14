/** A one-line tab bar. When the tabs don't fit, it scrolls sideways with arrow buttons and faded edges. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';

export function TabStrip({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ back: false, fwd: false });
  const update = useCallback(() => {
    const el = ref.current; if (!el) return;
    const max = el.scrollWidth - el.clientWidth, x = Math.abs(el.scrollLeft);
    setEdge((p) => { const n = { back: x > 2, fwd: x < max - 2 }; return p.back === n.back && p.fwd === n.fwd ? p : n; });
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(update); ro.observe(el); update();
    return () => ro.disconnect();
  }, [update]);
  // Keep the selected tab in view (sideways only — never scrolls the page).
  useEffect(() => {
    const el = ref.current; const a = el?.querySelector<HTMLElement>('.active'); if (!el || !a) return;
    const er = el.getBoundingClientRect(), ar = a.getBoundingClientRect();
    if (ar.left < er.left + 28) el.scrollLeft -= er.left + 28 - ar.left;
    else if (ar.right > er.right - 28) el.scrollLeft += ar.right - (er.right - 28);
  });
  const by = (dir: 1 | -1) => {
    const el = ref.current; if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: (rtl ? -dir : dir) * el.clientWidth * 0.7, behavior: 'smooth' });
  };
  return (
    <div className={`tab-strip ${edge.back ? 'can-back' : ''} ${edge.fwd ? 'can-fwd' : ''}`}>
      <button type="button" className="tab-arrow tab-back" tabIndex={-1} aria-label={t('common.scrollBack')} onClick={() => by(-1)}>‹</button>
      <div ref={ref} className={`tabs ${className}`} role="tablist" onScroll={update}>{children}</div>
      <button type="button" className="tab-arrow tab-fwd" tabIndex={-1} aria-label={t('common.scrollMore')} onClick={() => by(1)}>›</button>
    </div>
  );
}
