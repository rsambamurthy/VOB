/** The contract's wording: draft from a template, choose each clause's wording (standard, a fallback or edited), make the Word and PDF, and send it for approval. */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Alert } from '../../components/ui';
import { useMergeFields, Wording, WordingBox } from '../../components/MergeFields';
import type { FlowViewData } from '../../components/ApprovalFlow';

interface Option { standard: string; fallbacks: { key: string; label: string; body: string }[]; guidance: string | null }
interface DraftClause { clauseId: string; group: string; title: string; variant: string; body: string; required: boolean; options: Option | null }
export interface Drafting {
  templates: { id: string; name: string; kind: string }[];
  template: { id: string; name: string; kind: string } | null;
  jurisdiction: string | null; jurisdictions: Record<string, string>; defaultJurisdiction: string;
  draft: { clauses: DraftClause[]; nonStandard: boolean; fallback: boolean; version: number; generatedVersion?: number; upToDate: boolean; savedAt: string; savedBy: string } | null;
  addable: { group: string; title: string; category: string }[];
  approvalOn: boolean;
  approval: FlowViewData;
}
type Choice = { group: string; variant: string; body: string };

export function DraftingCard<D extends { drafting: Drafting }>({ contractId, status, drafting, manage, onDetail }: {
  contractId: string; status: string; drafting: Drafting; manage: boolean; onDetail: (d: D, message?: string, kind?: 'success' | 'warning' | 'error') => void;
}) {
  const pdf = useMergeFields()?.pdf;
  const dr = drafting.draft;
  const [tpl, setTpl] = useState(drafting.template?.id ?? drafting.templates[0]?.id ?? '');
  const [jur, setJur] = useState(drafting.jurisdiction ?? drafting.defaultJurisdiction);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [open, setOpen] = useState<string>();
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setChoices(dr?.clauses.map((c) => ({ group: c.group, variant: c.variant, body: c.body })) ?? []); }, [dr?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = manage && status === 'DRAFT';
  const dirty = !!dr && JSON.stringify(choices) !== JSON.stringify(dr.clauses.map((c) => ({ group: c.group, variant: c.variant, body: c.body })));
  async function call(path: string, method: string, body?: unknown, ok?: (r: D & { result?: any }) => string) {
    setBusy(true);
    try { const r = await api<D & { result?: any }>(`/staff/contracts/${contractId}/${path}`, { method, body: body ?? {} }); onDetail(r, ok?.(r)); return r; }
    catch (e: any) { onDetail(undefined as unknown as D, e.message, 'error'); return null; } finally { setBusy(false); }
  }
  const set = (group: string, patch: Partial<Choice>) => setChoices((cs) => cs.map((c) => (c.group === group ? { ...c, ...patch } : c)));
  const meta = (g: string) => dr?.clauses.find((c) => c.group === g);

  if (!dr || restart) {
    if (!editable || !drafting.templates.length) return status === 'DRAFT' && manage ? (
      <section className="card pad section-card"><h3>Wording</h3><p className="muted small">No template fits this contract type yet. Add one in Contracts → Templates, or upload the draft as a file.</p></section>) : null;
    return (
      <section className="card pad section-card" aria-label="Draft from a template">
        <h3>Draft from a template</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Start the wording from a template. Clauses follow the country you choose (governing law, disputes, tax).{restart ? ' Starting again replaces the current wording.' : ''}</p>
        <div className="field-grid">
          <div className="field"><label htmlFor="dr-tpl">Template</label><select id="dr-tpl" value={tpl} onChange={(e) => setTpl(e.target.value)}>{drafting.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.kind === 'WORD' ? ' (Word)' : ''}</option>)}</select></div>
          <div className="field"><label htmlFor="dr-jur">Country</label><select id="dr-jur" value={jur} onChange={(e) => setJur(e.target.value)}>{Object.entries(drafting.jurisdictions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div>
        <div className="btn-row">
          {restart && <button className="btn btn-secondary" onClick={() => setRestart(false)}>Cancel</button>}
          <button className="btn btn-primary" disabled={busy || !tpl} onClick={() => call('draft', 'POST', { templateId: tpl, jurisdiction: jur }, () => 'Draft started. Check each clause, then make the document.').then((r) => r && setRestart(false))}>Start drafting</button>
        </div>
      </section>
    );
  }

  const badge = (c: Choice) => (c.variant === 'custom' ? <span className="badge sm flag-medium">Edited</span> : c.variant !== 'standard' ? <span className="badge sm badge-invited">Fallback</span> : null);
  return (
    <section className="card pad section-card" aria-label="Wording">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
        <div><h3 style={{ marginBottom: 2 }}>Wording</h3>
          <p className="muted small" style={{ marginTop: 0 }}>{drafting.template?.name}{drafting.template?.kind === 'WORD' ? ' (Word)' : ''} · {drafting.jurisdictions[drafting.jurisdiction ?? ''] ?? drafting.jurisdiction} · saved by {dr.savedBy}, {fmtDateTime(dr.savedAt)}</p></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'end' }}>
          {dr.nonStandard && <span className="badge sm flag-medium">Non-standard wording</span>}
          {dr.fallback && <span className="badge sm badge-invited">Fallback used</span>}
          {!dr.nonStandard && !dr.fallback && <span className="badge sm badge-approved">Standard wording</span>}
        </div>
      </div>
      <ol className="plain-list" style={{ margin: '8px 0 0', padding: 0 }}>{choices.map((c, i) => {
        const m = meta(c.group); const o = m?.options;
        const expanded = open === c.group || c.variant === 'custom';
        return (
          <li key={c.group} style={{ borderTop: '1px solid var(--border, #e5e7ef)', padding: '10px 0' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="link-btn strong" aria-expanded={expanded} onClick={() => setOpen(open === c.group ? undefined : c.group)}>{i + 1}. {m?.title ?? c.group}</button>
              {badge(c)}
              {!m?.required && <span className="muted small">optional</span>}
              <span style={{ flex: 1 }} />
              {editable && o && <select aria-label={`Wording for ${m?.title}`} value={c.variant} onChange={(e) => {
                const v = e.target.value;
                set(c.group, { variant: v, body: v === 'standard' ? o.standard : v === 'custom' ? c.body : o.fallbacks.find((f) => f.key === v)?.body ?? c.body });
                if (v === 'custom') setOpen(c.group);
              }}>
                <option value="standard">Standard</option>
                {o.fallbacks.map((f) => <option key={f.key} value={f.key}>Fallback: {f.label}</option>)}
                <option value="custom">Edit the wording…</option>
              </select>}
              {editable && !m?.required && <button className="icon-btn" aria-label={`Leave out ${m?.title}`} onClick={() => setChoices(choices.filter((x) => x.group !== c.group))}>×</button>}
            </div>
            {expanded && <div style={{ marginTop: 8 }}>
              {o?.guidance && <p className="small" style={{ margin: '0 0 6px', color: 'var(--warn-ink, #8a5a00)' }}>Note: {o.guidance}</p>}
              {editable && c.variant === 'custom'
                ? <WordingBox id={`dc-${c.group}`} label="Wording (edited — the contract becomes non-standard)" value={c.body} onChange={(body) => set(c.group, { body })} rows={6} />
                : <div className="small"><Wording text={c.body} /></div>}
            </div>}
          </li>
        );
      })}</ol>
      {editable && drafting.addable.length > 0 && <select aria-label="Add a clause" value="" style={{ marginTop: 8, maxWidth: 360 }} onChange={(e) => { const g = drafting.addable.find((x) => x.group === e.target.value); if (g) setChoices([...choices, { group: g.group, variant: 'standard', body: '' }]); }}>
        <option value="">+ Add a clause from the library (non-standard)…</option>
        {drafting.addable.map((g) => <option key={g.group} value={g.group}>{g.title} · {g.category}</option>)}
      </select>}
      {editable && <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setRestart(true)}>Start again from a template</button>
        <span style={{ flex: 1 }} />
        {dirty && <button className="btn btn-secondary" disabled={busy} onClick={() => setChoices(dr.clauses.map((c) => ({ group: c.group, variant: c.variant, body: c.body })))}>Undo changes</button>}
        {dirty ? <button className="btn btn-primary" disabled={busy} onClick={() => call('draft', 'PUT', { clauses: choices.map((c) => ({ group: c.group, variant: c.variant, ...(c.variant === 'custom' ? { body: c.body } : {}) })) }, () => 'Wording saved.')}>Save wording</button>
          : <button className={`btn ${dr.upToDate ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={() => call('document', 'POST', {}, (r) => {
            const miss = r.result?.missing as { label: string }[] | undefined;
            return `${r.result?.pdf ? 'Word and PDF made' : 'Word document made'}.${miss?.length ? ` Still blank in the document: ${miss.map((x) => x.label).join(', ')}.` : ''}`;
          })}>{dr.upToDate ? 'Make the document again' : `Make the document (Word${pdf ? ' and PDF' : ''})`}</button>}
        {!dirty && drafting.approvalOn && <button className="btn btn-primary" disabled={busy || !dr.upToDate} title={dr.upToDate ? undefined : 'Make the document first'} onClick={() => call('submit', 'POST', {}, (r) => (r.result?.status === 'APPROVED' ? 'No approval was needed — the contract is approved.' : `Sent for approval: ${(r.result?.levels ?? []).join(' → ')}.`))}>Submit for approval</button>}
      </div>}
      {editable && !dr.upToDate && !dirty && <p className="small muted" style={{ marginBottom: 0 }}>The document is out of date — the wording or the contract’s details changed since it was made.</p>}
    </section>
  );
}

/** Withdraw from approval, or reopen an approved contract (approval then starts again). */
export function ReopenButton({ contractId, status, onDetail }: { contractId: string; status: string; onDetail: (d: any, message?: string, kind?: 'success' | 'error') => void }) {
  if (status !== 'IN_APPROVAL' && status !== 'APPROVED') return null;
  const label = status === 'IN_APPROVAL' ? 'Withdraw from approval' : 'Reopen as draft';
  return <button className="btn btn-secondary" onClick={async () => {
    if (!confirm(status === 'IN_APPROVAL' ? 'Withdraw the contract from approval? It goes back to draft.' : 'Reopen the approved contract as a draft? It will need approval again.')) return;
    try { onDetail(await api(`/staff/contracts/${contractId}/reopen`, { method: 'POST' }), status === 'IN_APPROVAL' ? 'Withdrawn — the contract is a draft again.' : 'Reopened as a draft.'); } catch (e: any) { onDetail(undefined, e.message, 'error'); }
  }}>{label}</button>;
}
