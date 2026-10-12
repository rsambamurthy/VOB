/**
 * F1 help: a panel on the right with help for the current screen, search and articles.
 * Open with F1, the floating "?" button, or openHelp('<article id>') from anywhere.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../lib/session';
import { ARTICLES, type Audience, type HelpArticle } from './articles';
import { searchHelp } from './search';

interface HelpApi { openHelp: (id?: string) => void; setContext: (ctx: string | null) => void; setExtra: (a: HelpArticle[]) => void }
const Ctx = createContext<HelpApi>({ openHelp: () => {}, setContext: () => {}, setExtra: () => {} });
export const useHelp = () => useContext(Ctx);

/** A screen tells help which part of it is showing (e.g. a configuration tab). */
export function useHelpContext(ctx: string | null) {
  const { setContext } = useHelp();
  useEffect(() => { setContext(ctx); return () => setContext(null); }, [ctx, setContext]);
}
/** A screen adds articles of its own (e.g. the buyer's portal guide for suppliers). */
export function useHelpExtra(articles: HelpArticle[] | null) {
  const { setExtra } = useHelp();
  const key = JSON.stringify(articles?.map((a) => a.id + a.body.length));
  useEffect(() => { setExtra(articles ?? []); return () => setExtra([]); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

function audienceFor(path: string): Audience {
  if (path.startsWith('/platform')) return 'platform';
  if (path.startsWith('/vendor') || path.startsWith('/onboard')) return 'supplier';
  if (path.startsWith('/staff')) return 'staff';
  return 'public';
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [context, setContext] = useState<string | null>(null);
  const [extra, setExtra] = useState<HelpArticle[]>([]);
  const audience = audienceFor(loc.pathname);

  // What this person may see: their audience, their permissions, their plan's features.
  const visible = useMemo(() => [...extra, ...ARTICLES].filter((a) => {
    if (!a.audience.includes(audience)) return false;
    if (audience === 'staff' && me) {
      if (a.perms && !a.perms.some((p) => me.permissions.includes(p))) return false;
      if (a.feature && me.plan && me.plan.features[a.feature] === false) return false;
    }
    return true;
  }), [audience, me, extra]);

  const forScreen = useMemo(() => {
    const byCtx = context ? visible.filter((a) => a.contexts?.includes(context)) : [];
    const byPath = visible.filter((a) => a.screens?.some((s) => new RegExp(s).test(loc.pathname)) && !byCtx.includes(a));
    return [...byCtx, ...byPath].slice(0, 6);
  }, [visible, context, loc.pathname]);

  const openHelp = useCallback((id?: string) => { setStack(id ? [id] : []); setQuery(''); setOpen(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); setOpen((o) => { if (!o) { setStack([]); setQuery(''); } return !o; }); }
      else if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // Browsers open their own help on F1 in some cases; this stops it where it can.
  useEffect(() => { const h = (e: Event) => e.preventDefault(); window.addEventListener('help', h); return () => window.removeEventListener('help', h); }, []);

  const api = useMemo(() => ({ openHelp, setContext, setExtra }), [openHelp]);
  const current = stack.length ? visible.find((a) => a.id === stack[stack.length - 1]) ?? ARTICLES.find((a) => a.id === stack[stack.length - 1]) : undefined;

  return (
    <Ctx.Provider value={api}>
      {children}
      {!open && <button className="help-fab" onClick={() => openHelp()} aria-label="Help (F1)" title="Help (F1)">?</button>}
      {open && (
        <>
          <div className="help-backdrop" onMouseDown={() => setOpen(false)} />
          <aside className="help-panel" role="dialog" aria-modal="false" aria-label="Help">
            <header className="help-head">
              {current ? <button className="help-back" onClick={() => setStack((s) => s.slice(0, -1))} aria-label="Back">←</button> : <span className="help-mark" aria-hidden>?</span>}
              <strong>Help</strong>
              <span className="help-key">F1</span>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close help">✕</button>
            </header>
            <SearchBox value={query} onChange={(v) => { setQuery(v); setStack([]); }} />
            <div className="help-body">
              {current ? <ArticleView a={current} visible={visible} go={(id) => setStack((s) => [...s, id])} />
                : query.trim() ? <Results query={query} visible={visible} go={(id) => setStack([id])} />
                : <Home forScreen={forScreen} visible={visible} audience={audience} go={(id) => setStack([id])} />}
            </div>
            <footer className="help-foot">Press <kbd>F1</kbd> on any screen for help with it · <kbd>Esc</kbd> to close</footer>
          </aside>
        </>
      )}
    </Ctx.Provider>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="help-search">
      <input ref={ref} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search help, e.g. “bank change” or “2FA”" aria-label="Search help" />
    </div>
  );
}

const Item = ({ a, go }: { a: HelpArticle; go: (id: string) => void }) => (
  <li><button className="help-item" onClick={() => go(a.id)}><span className="help-item-t">{a.title}</span><span className="help-item-s">{a.summary}</span></button></li>
);

function Home({ forScreen, visible, audience, go }: { forScreen: HelpArticle[]; visible: HelpArticle[]; audience: Audience; go: (id: string) => void }) {
  const rest = visible.filter((a) => !forScreen.includes(a));
  return (
    <>
      {forScreen.length > 0 && (<><h4 className="help-sec">On this screen</h4><ul className="help-list">{forScreen.map((a) => <Item key={a.id} a={a} go={go} />)}</ul></>)}
      <h4 className="help-sec">{forScreen.length ? 'All topics' : audience === 'supplier' ? 'Help for suppliers' : 'Help topics'}</h4>
      <ul className="help-list compact">{rest.map((a) => <Item key={a.id} a={a} go={go} />)}</ul>
    </>
  );
}

function Results({ query, visible, go }: { query: string; visible: HelpArticle[]; go: (id: string) => void }) {
  const results = useMemo(() => searchHelp(query, visible), [query, visible]);
  if (!results.length) return <p className="help-empty">No help topics match “{query}”. Try fewer or different words, for example “approve”, “bank” or “password”.</p>;
  return <><h4 className="help-sec">{results.length} result{results.length === 1 ? '' : 's'}</h4><ul className="help-list">{results.map((r) => <Item key={r.a.id} a={r.a} go={go} />)}</ul></>;
}

function ArticleView({ a, visible, go }: { a: HelpArticle; visible: HelpArticle[]; go: (id: string) => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.closest('.help-body')?.scrollTo({ top: 0 }); }, [a.id]);
  const related = (a.related ?? []).map((id) => visible.find((x) => x.id === id)).filter(Boolean) as HelpArticle[];
  return (
    <article className="help-article" ref={body}>
      <h2>{a.title}</h2>
      <HelpBody text={a.body} go={go} known={new Set(visible.map((x) => x.id))} />
      {related.length > 0 && (<><h4 className="help-sec">Related topics</h4><ul className="help-list compact">{related.map((r) => <Item key={r.id} a={r} go={go} />)}</ul></>)}
    </article>
  );
}

/* ---------- a very small renderer for the article markup (see articles.ts) ---------- */

function inline(text: string, go: (id: string) => void, known: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(#([a-z0-9-]+)\)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={k++}>{m[2]}</em>);
    else if (m[3]) out.push(<code key={k++}>{m[3]}</code>);
    else if (m[4]) { const id = m[5]; out.push(known.has(id) ? <button key={k++} className="help-link" onClick={() => go(id)}>{m[4]}</button> : m[4]); }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** React doesn't reflect `muted` to the element, and browsers only autoplay muted video, so set it here. */
const autoplay = (v: HTMLVideoElement | null) => { if (v) { v.muted = true; v.play().catch(() => {}); } };

export function HelpBody({ text, go, known }: { text: string; go: (id: string) => void; known: Set<string> }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const img = b.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (img) return <a key={i} href={img[2]} target="_blank" rel="noreferrer" className="help-shot" title="Open full size"><img src={img[2]} alt={img[1]} loading="lazy" /></a>;
        const vid = b.match(/^@video\(([^|)]+)\|?([^)]*)\)$/);
        if (vid) return <figure key={i} className="help-video"><video ref={autoplay} autoPlay loop muted playsInline aria-label={vid[2].trim()}><source src={vid[1].trim().replace(/\.mp4$/, '.webm')} type='video/webm' /><source src={vid[1].trim()} type='video/mp4' /></video><figcaption>▶ {vid[2].trim()}</figcaption></figure>;
        if (b.startsWith('## ')) {
          const [h, ...rest] = lines;
          return <div key={i}><h3>{h.slice(3)}</h3>{rest.length > 0 && <p>{inline(rest.join(' '), go, known)}</p>}</div>;
        }
        if (lines.every((l) => /^- /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2), go, known)}</li>)}</ul>;
        if (lines.every((l) => /^\d+\. /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+\. /, ''), go, known)}</li>)}</ol>;
        if (b.startsWith('> ')) return <p key={i} className="help-tip">{inline(lines.map((l) => l.replace(/^> /, '')).join(' '), go, known)}</p>;
        return <p key={i}>{inline(lines.join(' '), go, known)}</p>;
      })}
    </>
  );
}
