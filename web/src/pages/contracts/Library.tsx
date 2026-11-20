/** Contracts → Clause library and Templates (built-in India + GCC content and the workspace's own, including Word templates). */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { typeLabel, useContractSetup } from '../../components/Contracts';
import { useMergeFields, Wording, WordingBox } from '../../components/MergeFields';

interface Fallback { key?: string; label: string; body: string }
interface Clause { id: string; group: string; jurisdiction: string; title: string; category: string; body: string; fallbacks: Fallback[]; guidance: string | null; builtIn: boolean; changed: boolean; status: string; updatedByName: string | null; updatedAt: string }
interface ClauseList { clauses: Clause[]; categories: string[]; jurisdictions: Record<string, string> }
const DIRECTION: Record<string, string> = { BOTH: 'Suppliers and customers', BUY: 'Suppliers', SELL: 'Customers' };

/* ---------------- clause library ---------------- */

export function ClauseLibrary() {
  useHelpContext('contract-library');
  const { can } = useSession();
  const manage = can('contracts.templates');
  const [q, setQ] = useState('');
  const [jur, setJur] = useState('');
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState<ClauseList>();
  const [open, setOpen] = useState<Clause | 'new'>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    const p = new URLSearchParams(); if (q) p.set('q', q); if (jur) p.set('jurisdiction', jur); if (archived) p.set('status', 'ARCHIVED');
    api<ClauseList>(`/staff/contract-library/clauses?${p}`).then(setData).catch((e) => setError(e.message));
  }, [q, jur, archived]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const byCategory = data ? [...new Set(data.clauses.map((c) => c.category))] : [];
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Clause library</h1><p className="muted">Standard wording and pre-approved fallbacks that templates are built from. The built-in clauses cover India, the UAE and Saudi Arabia — have your counsel review them before first use.</p></div>
        {manage && <div className="head-actions"><button className="btn btn-primary" onClick={() => setOpen('new')}>+ New clause</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <TabStrip>{[['', 'In use'], ['ARCHIVED', 'Archived']].map(([k, l]) => <button key={k || 'active'} role="tab" aria-selected={archived === !!k} className={archived === !!k ? 'active' : ''} onClick={() => setArchived(!!k)}>{l}</button>)}</TabStrip>
      <div className="card">
        <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="search" placeholder="Search titles and wording…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clauses" />
          <select aria-label="Country" value={jur} onChange={(e) => setJur(e.target.value)}><option value="">All countries</option>{data && Object.entries(data.jurisdictions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.clauses.length === 0 ? <Empty>No clauses match.</Empty> : byCategory.map((cat) => (
          <div key={cat}>
            <h4 className="muted" style={{ margin: '14px 16px 4px', textTransform: 'uppercase', fontSize: 12, letterSpacing: '.04em' }}>{cat}</h4>
            <table className="table"><tbody>{data.clauses.filter((c) => c.category === cat).map((c) => (
              <tr key={c.id} onClick={() => setOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(c)}>
                <td style={{ width: '32%' }}><div className="strong">{c.title}</div><div className="muted small">{c.jurisdiction === 'ALL' ? 'All countries' : data.jurisdictions[c.jurisdiction]}</div></td>
                <td className="small muted">{c.body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '…').slice(0, 140)}{c.body.length > 140 ? '…' : ''}</td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{c.fallbacks.length > 0 && <span className="badge sm">{c.fallbacks.length} fallback{c.fallbacks.length === 1 ? '' : 's'}</span>} {c.builtIn ? <span className={`badge sm ${c.changed ? 'flag-medium' : ''}`}>{c.changed ? 'Built-in, changed' : 'Built-in'}</span> : <span className="badge sm badge-invited">Your own</span>}</td>
              </tr>))}</tbody></table>
          </div>
        ))}
      </div>
      {open && data && <ClauseModal clause={open === 'new' ? null : open} categories={data.categories} jurisdictions={data.jurisdictions} manage={manage} onClose={() => setOpen(undefined)} onSaved={() => { setOpen(undefined); load(); }} />}
    </div>
  );
}

function ClauseModal({ clause, categories, jurisdictions, manage, onClose, onSaved }: { clause: Clause | null; categories: string[]; jurisdictions: Record<string, string>; manage: boolean; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState({ title: clause?.title ?? '', category: clause?.category ?? '', jurisdiction: clause?.jurisdiction ?? 'ALL', body: clause?.body ?? '', fallbacks: clause?.fallbacks ?? [] as Fallback[], guidance: clause?.guidance ?? '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const edit = manage && clause?.status !== 'ARCHIVED';
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await fn(); onSaved(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const save = () => run(() => api(clause ? `/staff/contract-library/clauses/${clause.id}` : '/staff/contract-library/clauses', { method: clause ? 'PUT' : 'POST', body: { ...c, guidance: c.guidance || null } }));
  const fb = (i: number, patch: Partial<Fallback>) => setC({ ...c, fallbacks: c.fallbacks.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  return (
    <Modal title={clause ? clause.title : 'New clause'} wide onClose={onClose} footer={<>
      {manage && clause?.builtIn && clause.changed && <button className="btn btn-secondary" disabled={busy} onClick={() => confirm('Put back the standard wording and fallbacks?') && run(() => api(`/staff/contract-library/clauses/${clause.id}/reset`, { method: 'POST' }))}>Reset to standard</button>}
      {manage && clause && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api(`/staff/contract-library/clauses/${clause.id}/archive`, { body: { archived: clause.status !== 'ARCHIVED' } }))}>{clause.status === 'ARCHIVED' ? 'Restore' : 'Archive'}</button>}
      <button className="btn btn-secondary" onClick={onClose}>{edit ? 'Cancel' : 'Close'}</button>
      {edit && <button className="btn btn-primary" disabled={busy || c.title.trim().length < 2 || c.body.trim().length < 10} onClick={save}>Save</button>}</>}>
      {error && <Alert kind="error">{error}</Alert>}
      {clause?.builtIn && <p className="muted small" style={{ marginTop: 0 }}>Built-in clause{clause.changed ? ', changed in your workspace' : ''}. Contracts already drafted keep the wording they were drafted with.</p>}
      <div className="field-grid">
        <div className="field"><label htmlFor="cl-title">Title</label><input id="cl-title" disabled={!edit} value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} /></div>
        <div className="field"><label htmlFor="cl-cat">Category</label><input id="cl-cat" list="cl-cats" disabled={!edit} value={c.category} onChange={(e) => setC({ ...c, category: e.target.value })} /><datalist id="cl-cats">{categories.map((x) => <option key={x} value={x} />)}</datalist></div>
        <div className="field"><label htmlFor="cl-jur">Country</label><select id="cl-jur" disabled={!edit || !!clause} value={c.jurisdiction} onChange={(e) => setC({ ...c, jurisdiction: e.target.value })}>{Object.entries(jurisdictions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        {edit ? <WordingBox id="cl-body" label="Standard wording" value={c.body} onChange={(body) => setC({ ...c, body })} rows={7} /> : <div className="field field-wide"><label>Standard wording</label><Wording text={c.body} /></div>}
      </div>
      <h4 style={{ margin: '14px 0 6px' }}>Fallbacks <span className="muted small" style={{ fontWeight: 400 }}>— pre-approved alternatives a drafter may pick (marked on the contract, and approval rules can ask for Legal)</span></h4>
      {c.fallbacks.map((f, i) => (
        <div key={i} className="card pad" style={{ marginBottom: 10, background: 'var(--surface-2, #f7f8fb)' }}>
          <div className="field-grid">
            <div className="field"><label htmlFor={`fb-l-${i}`}>Fallback name</label><input id={`fb-l-${i}`} disabled={!edit} value={f.label} onChange={(e) => fb(i, { label: e.target.value })} /></div>
            {edit ? <WordingBox id={`fb-b-${i}`} label="Wording" value={f.body} onChange={(body) => fb(i, { body })} rows={5} /> : <div className="field field-wide"><Wording text={f.body} /></div>}
          </div>
          {edit && <button className="link-btn small" onClick={() => setC({ ...c, fallbacks: c.fallbacks.filter((_, j) => j !== i) })}>Remove fallback</button>}
        </div>
      ))}
      {edit && c.fallbacks.length < 6 && <button className="link-btn small" onClick={() => setC({ ...c, fallbacks: [...c.fallbacks, { label: '', body: c.body }] })}>+ Add fallback</button>}
      <div className="field" style={{ marginTop: 12 }}><label htmlFor="cl-guide">Guidance for drafters (not printed)</label><textarea id="cl-guide" rows={2} disabled={!edit} value={c.guidance} onChange={(e) => setC({ ...c, guidance: e.target.value })} /></div>
    </Modal>
  );
}

/* ---------------- templates ---------------- */

interface Template { id: string; name: string; kind: 'CLAUSES' | 'WORD'; types: string[]; direction: string; heading: string | null; preamble: string | null; sections: { group: string; required: boolean }[]; fileName: string | null; fields: string[]; builtIn: boolean; status: string; updatedAt: string; updatedByName: string | null }
interface Group { group: string; title: string; category: string; jurisdictions: string[] }

export function TemplatesList() {
  useHelpContext('contract-templates');
  const { can } = useSession();
  const setup = useContractSetup();
  const nav = useNavigate();
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState<{ templates: Template[]; word: boolean; clauses: boolean }>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<typeof data>(`/staff/contract-library/templates${archived ? '?status=ARCHIVED' : ''}`).then(setData).catch((e) => setError(e.message)); }, [archived]);
  const manage = can('contracts.templates');
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Templates</h1><p className="muted">Contracts are drafted from these: built from the clause library, or your own Word documents with merge fields.</p></div>
        {manage && data && <div className="head-actions">
          {data.word && <button className="btn btn-secondary" onClick={() => nav('/staff/contract-templates/new?kind=WORD')}>Upload Word template</button>}
          {data.clauses && <button className="btn btn-primary" onClick={() => nav('/staff/contract-templates/new')}>+ New template</button>}</div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <TabStrip>{[['', 'In use'], ['ARCHIVED', 'Archived']].map(([k, l]) => <button key={k || 'active'} role="tab" aria-selected={archived === !!k} className={archived === !!k ? 'active' : ''} onClick={() => setArchived(!!k)}>{l}</button>)}</TabStrip>
      <div className="card">
        {!data ? <div className="pad"><div className="spinner" /></div> : data.templates.length === 0 ? <Empty>No templates.</Empty> : (
          <table className="table"><thead><tr><th>Template</th><th>Made from</th><th>Contract types</th><th>For</th><th>Changed</th></tr></thead>
            <tbody>{data.templates.map((t) => (
              <tr key={t.id} onClick={() => nav(`/staff/contract-templates/${t.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/contract-templates/${t.id}`)}>
                <td><Link className="strong" to={`/staff/contract-templates/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.name}</Link>{t.builtIn && <span className="badge sm" style={{ marginInlineStart: 6 }}>Built-in</span>}</td>
                <td className="small">{t.kind === 'WORD' ? <>Word file <span className="muted">· {t.fileName}</span></> : `${t.sections.length} library clauses`}</td>
                <td className="small">{t.types.map((k) => typeLabel(setup, k)).join(', ')}</td>
                <td className="small">{DIRECTION[t.direction]}</td>
                <td className="small muted">{fmtDate(t.updatedAt)}{t.updatedByName ? ` · ${t.updatedByName}` : ''}</td>
              </tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}

export function TemplateEditor() {
  useHelpContext('contract-templates');
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const kindParam = new URLSearchParams(location.search).get('kind') === 'WORD' ? 'WORD' : 'CLAUSES';
  const { can } = useSession();
  const setup = useContractSetup();
  const merge = useMergeFields();
  const nav = useNavigate();
  const [t, setT] = useState<Template>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [file, setFile] = useState<File>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isNew) {
      setT({ id: '', name: '', kind: kindParam, types: [], direction: 'BOTH', heading: '', preamble: kindParam === 'CLAUSES' ? 'This agreement (the “Agreement”) is made on {{today}} between {{us.legalName}}, {{us.address}} (the “{{us.role}}”), and {{party.legalName}}, {{party.address}} (the “{{party.role}}”).' : '', sections: [], fileName: null, fields: [], builtIn: false, status: 'ACTIVE', updatedAt: '', updatedByName: null });
      api<{ groups: Group[] }>('/staff/contract-library/clauses/groups').then((r) => setGroups(r.groups)).catch(() => {});
    } else api<{ template: Template; groups: Group[] }>(`/staff/contract-library/templates/${id}`).then((r) => { setT(r.template); setGroups(r.groups); }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [id, isNew, kindParam]);
  if (!t || !setup) return <div className="page">{msg ? <Alert kind="error">{msg.text}</Alert> : <div className="spinner" />}</div>;
  const manage = can('contracts.templates') && t.status === 'ACTIVE';
  const groupOf = (g: string) => groups.find((x) => x.group === g);
  const move = (i: number, d: number) => { const s = [...t.sections]; const [x] = s.splice(i, 1); s.splice(i + d, 0, x); setT({ ...t, sections: s }); };
  async function save() {
    setBusy(true); setMsg(undefined);
    const body = { name: t!.name, types: t!.types, direction: t!.direction, heading: t!.heading || null, preamble: t!.preamble || null, sections: t!.sections };
    try {
      let r: { template: Template };
      if (t!.kind === 'WORD') {
        const fd = new FormData(); fd.append('data', JSON.stringify(body)); if (file) fd.append('file', file);
        r = await api(isNew ? '/staff/contract-library/templates/word' : `/staff/contract-library/templates/${t!.id}/word`, { method: isNew ? 'POST' : 'PUT', body: fd });
      } else r = await api(isNew ? '/staff/contract-library/templates' : `/staff/contract-library/templates/${t!.id}`, { method: isNew ? 'POST' : 'PUT', body });
      setT(r.template); setFile(undefined); setMsg({ kind: 'success', text: 'Template saved. New drafts use it; contracts already drafted keep their wording.' });
      if (isNew) nav(`/staff/contract-templates/${r.template.id}`, { replace: true });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  const archive = async () => { try { setT((await api<{ template: Template }>(`/staff/contract-library/templates/${t.id}/archive`, { body: { archived: t.status !== 'ARCHIVED' } })).template); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } };
  const fieldLabel = (k: string) => merge?.fields.find((f) => f.key === k)?.label;
  return (
    <div className="page">
      <nav className="breadcrumb"><Link to="/staff/contract-templates">Templates</Link> › {isNew ? 'New' : t.name}</nav>
      <header className="page-head">
        <div><h1>{isNew ? (t.kind === 'WORD' ? 'Upload a Word template' : 'New template') : t.name}</h1><p className="muted">{t.kind === 'WORD' ? 'Your own Word document with merge fields' : 'Built from the clause library'}{t.builtIn ? ' · built-in' : ''}{t.status === 'ARCHIVED' ? ' · archived' : ''}</p></div>
        {can('contracts.templates') && !isNew && <div className="head-actions"><button className="btn btn-secondary" onClick={archive}>{t.status === 'ARCHIVED' ? 'Restore' : 'Archive'}</button></div>}
      </header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <section className="card pad section-card">
        <h3>Details</h3>
        <div className="field-grid">
          <div className="field field-wide"><label htmlFor="tp-name">Name</label><input id="tp-name" disabled={!manage} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="tp-dir">For</label><select id="tp-dir" disabled={!manage} value={t.direction} onChange={(e) => setT({ ...t, direction: e.target.value })}>{Object.entries(DIRECTION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="field field-wide"><label>Contract types</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>{setup.config.types.filter((k) => k.on).map((k) => (
              <label key={k.key} className="check-item"><input type="checkbox" disabled={!manage} checked={t.types.includes(k.key)} onChange={(e) => setT({ ...t, types: e.target.checked ? [...t.types, k.key] : t.types.filter((x) => x !== k.key) })} /> <span>{k.label}</span></label>))}</div></div>
          {t.kind === 'CLAUSES' && <>
            <div className="field field-wide"><label htmlFor="tp-head">Document heading</label><input id="tp-head" disabled={!manage} value={t.heading ?? ''} placeholder="e.g. SERVICE AGREEMENT" onChange={(e) => setT({ ...t, heading: e.target.value })} /></div>
            <WordingBox id="tp-pre" label="Opening paragraph (parties)" value={t.preamble ?? ''} onChange={(preamble) => setT({ ...t, preamble })} rows={4} disabled={!manage} />
          </>}
        </div>
      </section>
      {t.kind === 'WORD' && (
        <section className="card pad section-card">
          <h3>Word file</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Write merge fields in the document as <span className="mono">{'{{party.legalName}}'}</span>. To print the drafted clauses, put <span className="mono">{'{{#clauses}}'}</span>, then <span className="mono">{'{{number}}. {{title}}'}</span> and <span className="mono">{'{{body}}'}</span> on their own lines, then <span className="mono">{'{{/clauses}}'}</span>. Macro-enabled files (.docm) aren’t accepted.</p>
          {t.fileName && <p><a href={`/api/staff/contract-library/templates/${t.id}/file`}>{t.fileName}</a> <span className="muted small">— download to edit, then upload the new version</span></p>}
          {manage && <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>{file ? file.name : t.fileName ? 'Replace the Word file…' : 'Choose the Word (.docx) file…'}<input type="file" hidden accept=".docx" aria-label="Word template file" onChange={(e) => setFile(e.target.files?.[0])} /></label>}
          {t.fields.length > 0 && <><h4 style={{ margin: '14px 0 6px' }}>Merge fields found</h4><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{t.fields.filter((f) => !['#clauses', '/clauses', 'number', 'title', 'body'].includes(f)).map((f) => <span key={f} className="badge sm" title={`{{${f}}}`}>{fieldLabel(f) ?? f}</span>)}{t.fields.includes('#clauses') && <span className="badge sm badge-approved">Prints the clauses</span>}</div></>}
        </section>
      )}
      <section className="card pad section-card">
        <h3>Clauses</h3>
        <p className="muted small" style={{ marginTop: 0 }}>{t.kind === 'WORD' ? 'Only needed when the Word file prints clauses. ' : ''}In this order. Each contract uses the clause for its country (India, UAE or Saudi Arabia) — a clause that has no version for that country is left out. Untick “Required” to let drafters leave a clause out.</p>
        {t.sections.length > 0 && <table className="table static compact"><thead><tr><th>#</th><th>Clause</th><th>Countries</th><th>Required</th><th /></tr></thead><tbody>{t.sections.map((s, i) => (
          <tr key={s.group}><td>{i + 1}</td><td>{groupOf(s.group)?.title ?? s.group}<div className="muted small">{groupOf(s.group)?.category}</div></td>
            <td className="small">{groupOf(s.group)?.jurisdictions.map((j) => (j === 'ALL' ? 'All' : j)).join(', ')}</td>
            <td><input type="checkbox" aria-label={`${groupOf(s.group)?.title ?? s.group} required`} disabled={!manage} checked={s.required} onChange={(e) => setT({ ...t, sections: t.sections.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /></td>
            <td className="actions" style={{ whiteSpace: 'nowrap' }}>{manage && <>
              <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="icon-btn" aria-label="Move down" disabled={i === t.sections.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="icon-btn" aria-label={`Remove ${groupOf(s.group)?.title ?? s.group}`} onClick={() => setT({ ...t, sections: t.sections.filter((_, j) => j !== i) })}>×</button></>}</td></tr>))}</tbody></table>}
        {manage && <select aria-label="Add a clause" value="" style={{ marginTop: 10, maxWidth: 360 }} onChange={(e) => e.target.value && setT({ ...t, sections: [...t.sections, { group: e.target.value, required: true }] })}>
          <option value="">+ Add a clause from the library…</option>
          {[...new Set(groups.map((g) => g.category))].map((cat) => <optgroup key={cat} label={cat}>{groups.filter((g) => g.category === cat && !t.sections.some((s) => s.group === g.group)).map((g) => <option key={g.group} value={g.group}>{g.title}</option>)}</optgroup>)}
        </select>}
      </section>
      {manage && <div className="btn-row"><button className="btn btn-secondary" onClick={() => nav('/staff/contract-templates')}>Cancel</button><button className="btn btn-primary" disabled={busy || t.name.trim().length < 3 || !t.types.length || (t.kind === 'WORD' && isNew && !file)} onClick={save}>{isNew ? 'Create template' : 'Save template'}</button></div>}
    </div>
  );
}
