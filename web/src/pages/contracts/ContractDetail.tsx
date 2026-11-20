/** One contract: details (editable as a draft; owner, notes and renewal terms once active), files, linked contracts, history. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtSize, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Modal } from '../../components/ui';
import { HistoryCard } from '../../components/HistoryCard';
import { ContractStatus, DIRECTION_LABEL, KIND_LABEL, typeLabel, useContractSetup, type Direction } from '../../components/Contracts';
import { contractBody, ContractForm, type ContractData } from './ContractForm';
import { DraftingCard, ReopenButton, type Drafting } from './Drafting';
import { NegotiationCard, SigningCard, type Negotiation, type Signing } from './Negotiation';
import { AmendmentsCard, AmendsCard, ErpCard, ObligationsCard, PricesCard, type Manage } from './Manage';
import { ReadingCard, type Reading } from './Insights';
import { ForReviewCard, type ContractWatch } from './Watch';
import { FlowPanel, type FlowDecision } from '../../components/ApprovalFlow';

interface Summary { id: string; number: string; reference: string | null; title: string; direction: Direction; type: string; status: string; value: number | null; currency: string; startDate: string | null; endDate: string | null; signedDate: string | null; autoRenew: boolean }
interface Detail {
  contract: Summary & { partyId: string; renewalTermMonths: number | null; noticeDays: number | null; ownerId: string | null; parentId: string | null; description: string | null; category: string | null; source: string; terminatedAt: string | null; terminationReason: string | null; createdByName: string; createdAt: string; daysLeft: number | null; expiring: boolean; noticeBy: string | null };
  party: { id: string; code: string; name: string; kind: string; country: string; contacts: { name: string; email?: string; signatory?: boolean }[] };
  owner: { id: string; name: string } | null; parent: Summary | null; children: Summary[];
  files: { id: string; kind: string; fileName: string; size: number; uploadedByName: string; uploadedAt: string; generated: boolean; version: number | null }[];
  drafting: Drafting;
  negotiation: Negotiation;
  signing: Signing;
  manage: Manage;
  reading: { ai: boolean; readings: Reading[] };
  watch: ContractWatch;
  history: { actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }[];
  editable: 'all' | string[];
}
const ACTIONS: Record<string, string> = {
  CONTRACT_CREATED: 'Created', CONTRACT_UPDATED: 'Details changed', CONTRACT_SIGNED: 'Marked as signed', CONTRACT_TERMINATED: 'Terminated', CONTRACT_EXPIRED: 'Expired',
  CONTRACT_RENEWED: 'Renewed automatically', CONTRACT_FILE_ADDED: 'File added', CONTRACT_FILE_REMOVED: 'File removed',
  CONTRACT_DRAFT_STARTED: 'Drafted from a template', CONTRACT_DRAFT_SAVED: 'Wording changed', CONTRACT_DOCUMENT_MADE: 'Document made', CONTRACT_SUBMITTED: 'Submitted for approval',
  CONTRACT_AMENDED: 'Amended', CONTRACT_OBLIGATION_ADDED: 'Obligation added', CONTRACT_OBLIGATION_UPDATED: 'Obligation changed', CONTRACT_OBLIGATION_DONE: 'Obligation done', CONTRACT_OBLIGATION_WAIVED: 'Obligation waived',
  CONTRACT_OBLIGATION_OPEN: 'Obligation reopened', CONTRACT_OBLIGATION_REMOVED: 'Obligation removed', CONTRACT_PRICES_SAVED: 'Prices saved', CONTRACT_SENT_TO_ERP: 'Sent to the ERP',
  CONTRACT_APPROVED: 'Approved', CONTRACT_SENT_FOR_REVIEW: 'Sent to the other party', CONTRACT_REVIEWER_SIGNED_IN: 'Opened by the other party', CONTRACT_PARTY_COMMENTED: 'Comment from the other party',
  CONTRACT_PARTY_UPLOADED: 'Marked-up copy from the other party', CONTRACT_PARTY_ACCEPTED: 'Accepted by the other party', CONTRACT_PARTY_CHANGES: 'Changes asked for', CONTRACT_COMMENT_SENT: 'Reply sent', CONTRACT_NOTE_ADDED: 'Internal note',
  CONTRACT_COMMENT_ACCEPTED: 'Their wording accepted', CONTRACT_COMMENT_DECLINED: 'Their wording declined', CONTRACT_COMMENT_RESOLVED: 'Comment resolved', CONTRACT_SENT_FOR_SIGNATURE: 'Sent for signature',
  CONTRACT_SIGNED_BY: 'Signed by', CONTRACT_SIGNATURE_DECLINED: 'Signature declined', CONTRACT_SIGNATURE_EXPIRED: 'Signature request expired', CONTRACT_SIGNATURE_CANCELLED: 'Signature request cancelled', CONTRACT_SIGNATURE_CANCELLED_BY: 'Signature request cancelled', CONTRACT_WITHDRAWN: 'Withdrawn from approval', CONTRACT_REOPENED: 'Reopened as draft', FLOW_STARTED: 'Approval started', FLOW_DECISION: 'Approval decision',
};
const toForm = (d: Detail): ContractData => ({
  title: d.contract.title, direction: d.contract.direction, type: d.contract.type, partyId: d.contract.partyId, reference: d.contract.reference ?? '', value: d.contract.value === null ? '' : String(d.contract.value),
  currency: d.contract.currency, startDate: d.contract.startDate ?? '', endDate: d.contract.endDate ?? '', signedDate: d.contract.signedDate ?? '', autoRenew: d.contract.autoRenew,
  renewalTermMonths: d.contract.renewalTermMonths === null ? '' : String(d.contract.renewalTermMonths), noticeDays: d.contract.noticeDays === null ? '' : String(d.contract.noticeDays),
  ownerId: d.contract.ownerId ?? '', parentId: d.contract.parentId ?? '', description: d.contract.description ?? '', category: d.contract.category ?? '',
});

export function ContractDetail() {
  useHelpContext('contracts');
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useSession();
  const setup = useContractSetup();
  const [d, setD] = useState<Detail>();
  const [form, setForm] = useState<ContractData>();
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'warning'; text: string }>();
  const [modal, setModal] = useState<'sign' | 'terminate' | null>(null);
  const take = (r: Detail) => { setD(r); setForm(toForm(r)); };
  const load = useCallback(() => api<Detail>(`/staff/contracts/${id}`).then(take).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<Detail | void>, ok: string) => {
    setFlash(undefined);
    try { const r = await fn(); if (r) take(r); setFlash({ kind: 'success', text: ok }); return true; } catch (e: any) { setFlash({ kind: 'error', text: e.message }); return false; }
  };
  if (!d || !form) return <div className="page">{flash ? <Alert kind="error">{flash.text}</Alert> : <div className="spinner" />}</div>;
  const c = d.contract;
  const manage = can('contracts.manage');
  const editable = d.editable === 'all' ? 'all' : d.editable;
  const signedCopy = d.files.some((f) => f.kind === 'SIGNED');
  const needsApproval = c.status === 'DRAFT' && !!d.drafting.draft && d.drafting.approvalOn;
  const freeDraft = c.status === 'DRAFT' && !d.drafting.approvalOn;
  const canShare = ['APPROVED', 'WITH_PARTY', 'AGREED'].includes(c.status) || (freeDraft && (d.drafting.draft ? d.drafting.draft.upToDate : d.files.some((f) => f.kind === 'DRAFT')));
  const canSign = c.status === 'AGREED' || c.status === 'APPROVED' || (freeDraft && !d.drafting.draft);
  const onDetail = (r: Detail | undefined, text?: string, kind: 'success' | 'warning' | 'error' = 'success') => { if (r) take(r); setFlash(text ? { kind: text.includes('Still blank') ? 'warning' : kind, text } : undefined); };
  async function decide(action: FlowDecision, remarks: string) {
    const r = await api<Detail & { decided?: boolean }>(`/staff/contracts/${c.id}/decision`, { body: { action, remarks } });
    if (r.decided) { setFlash({ kind: 'success', text: 'Thank you — your decision is recorded.' }); setD({ ...d!, drafting: { ...d!.drafting, approval: { ...d!.drafting.approval, canAct: false } } }); }
    else take(r);
  }
  async function save() {
    if (await run(() => api<Detail>(`/staff/contracts/${c.id}`, { method: 'PATCH', body: contractBody(form!, editable === 'all' ? undefined : editable) }), 'Saved.')) setEditing(false);
  }
  async function upload(kind: string, file: File) {
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', file);
    await run(() => api<Detail>(`/staff/contracts/${c.id}/files`, { body: fd }), `${setup?.fileKinds[kind] ?? 'File'} uploaded.`);
  }
  return (
    <div className="page">
      <nav className="breadcrumb"><Link to="/staff/contracts">Contracts</Link> › {c.number}</nav>
      <header className="page-head">
        <div><h1>{c.title}</h1>
          <p className="muted"><span className="mono">{c.number}</span>{c.reference && <> · their ref. {c.reference}</>} · {typeLabel(setup, c.type)} · {DIRECTION_LABEL[c.direction]} · <ContractStatus status={c.status} expiring={c.expiring} /></p></div>
        {manage && <div className="head-actions">
          {editable.length > 0 && !editing && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          <ReopenButton contractId={c.id} status={c.status} onDetail={onDetail} />
          {((c.status === 'DRAFT' && !needsApproval) || ['APPROVED', 'AGREED', 'WITH_PARTY'].includes(c.status)) && <button className="btn btn-secondary" onClick={() => setModal('sign')} disabled={!signedCopy} title={signedCopy ? undefined : 'Upload the signed copy first'}>Mark as signed</button>}
          {c.status === 'ACTIVE' && <button className="btn btn-danger" onClick={() => setModal('terminate')}>Terminate</button>}
          {c.status === 'DRAFT' && <button className="btn btn-secondary" onClick={async () => { if (confirm(`Delete draft ${c.number}? This can’t be undone.`) && await run(() => api(`/staff/contracts/${c.id}`, { method: 'DELETE' }).then(() => {}), 'Deleted.')) nav('/staff/contracts'); }}>Delete draft</button>}
        </div>}
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      {c.status === 'DRAFT' && !d.drafting.draft && <Alert kind="info">Draft — draft the wording from a template below, or upload your own draft. Once it is signed, upload the signed copy and mark it as signed.</Alert>}
      {c.status === 'IN_APPROVAL' && <Alert kind="info">Waiting for approval{d.drafting.approval.current ? ` — ${d.drafting.approval.current.label}` : ''}. The contract can’t be changed while it is in approval.</Alert>}
      {c.status === 'APPROVED' && <Alert kind="success">Approved. Send it to {d.party.name} for review, or straight for signature.</Alert>}
      {c.status === 'WITH_PARTY' && <Alert kind="info">With {d.party.name} for review. Their comments and answer appear below.</Alert>}
      {c.status === 'AGREED' && <Alert kind="success">{d.party.name} accepted the wording. Send it for signature.</Alert>}
      {c.status === 'SIGNING' && <Alert kind="info">Out for signature. It becomes active automatically when everyone has signed.</Alert>}
      {c.status === 'TERMINATED' && <Alert kind="warning">Terminated{c.terminatedAt ? ` on ${fmtDate(c.terminatedAt)}` : ''}: {c.terminationReason}</Alert>}
      {c.expiring && <Alert kind="warning">Ends in {c.daysLeft} day{c.daysLeft === 1 ? '' : 's'}{c.autoRenew ? ' — it renews automatically' : ''}.{c.noticeBy && c.autoRenew ? (c.noticeBy < new Date().toISOString().slice(0, 10) ? ` The last day to give notice (${fmtDate(c.noticeBy)}) has passed, so it will renew.` : ` Notice to stop the renewal is due by ${fmtDate(c.noticeBy)}.`) : ''}</Alert>}

      <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          <section className="card pad section-card">
            <h3>Details</h3>
            {editing && setup ? <>
              {editable !== 'all' && <p className="muted small">An active contract’s parties, dates and value change through an amendment (coming in a later release). You can change the owner, reference, category, description and renewal terms.</p>}
              <ContractForm value={form} onChange={setForm} setup={setup} editable={editable} />
              <div className="btn-row"><button className="btn btn-secondary" onClick={() => { setForm(toForm(d)); setEditing(false); }}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></div>
            </> : (
              <dl className="kv">
                <dt>{KIND_LABEL[d.party.kind]}</dt><dd><Link to={`/staff/parties/${d.party.id}`}>{d.party.name}</Link> <span className="muted small mono">{d.party.code}</span></dd>
                <dt>Value</dt><dd>{c.value === null ? '—' : money(c.value, c.currency)}</dd>
                <dt>Term</dt><dd>{fmtDate(c.startDate)} – {c.endDate ? fmtDate(c.endDate) : 'no fixed end'}</dd>
                <dt>Signed</dt><dd>{c.signedDate ? fmtDate(c.signedDate) : 'Not yet'}</dd>
                <dt>Renewal</dt><dd>{c.autoRenew ? `Renews automatically for ${d.contract.renewalTermMonths} months` : 'Ends on the end date'}{d.contract.noticeDays !== null ? ` · ${d.contract.noticeDays} days’ notice` : ''}{c.noticeBy ? ` (by ${fmtDate(c.noticeBy)})` : ''}</dd>
                <dt>Owner</dt><dd>{d.owner?.name ?? '—'}</dd>
                {d.contract.category && <><dt>Category</dt><dd>{d.contract.category}</dd></>}
                {d.contract.description && <><dt>Description</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.contract.description}</dd></>}
                <dt>Recorded</dt><dd className="small">{d.contract.createdByName} · {fmtDateTime(d.contract.createdAt)}{d.contract.source === 'IMPORT' ? ' · imported from Excel' : ''}</dd>
              </dl>
            )}
          </section>

          <ForReviewCard watch={d.watch} manage={manage} onChanged={(text) => { setFlash({ kind: 'success', text: text ?? 'Recorded.' }); load(); }} />
          <AmendsCard m={d.manage} />
          {c.status !== 'SIGNING' && <ReadingCard contractId={c.id} files={d.files} reading={d.reading} editable={editable} manage={manage} onDetail={onDetail} />}
          <DraftingCard<Detail> contractId={c.id} status={c.status} drafting={d.drafting} manage={manage} onDetail={onDetail} />
          <NegotiationCard contractId={c.id} status={c.status} partyName={d.party.name} clauses={d.drafting.draft?.clauses ?? []} n={d.negotiation} manage={manage} canShare={canShare} onDetail={onDetail} />
          <AmendmentsCard contract={{ ...c, noticeDays: d.contract.noticeDays, renewalTermMonths: d.contract.renewalTermMonths }} m={d.manage} manage={manage} />
          <ObligationsCard contractId={c.id} m={d.manage} manage={manage} ended={c.status === 'EXPIRED' || c.status === 'TERMINATED'} owners={setup?.owners ?? []} partyName={d.party.name} onDetail={onDetail} />
          {c.type !== 'amendment' && <PricesCard contractId={c.id} currency={c.currency} m={d.manage} manage={manage} editable={!['EXPIRED', 'TERMINATED', 'SIGNING'].includes(c.status)} onDetail={onDetail} reload={load} />}
          {c.type !== 'amendment' && c.direction === 'BUY' && <ErpCard contractId={c.id} m={d.manage} manage={manage} active={c.status === 'ACTIVE'} onDetail={onDetail} />}
          <SigningCard contractId={c.id} status={c.status} partyName={d.party.name} s={d.signing} contacts={d.negotiation.contacts} me={{ name: me?.user.name ?? '', email: me?.user.email ?? '' }} manage={manage} canSend={canSign} onDetail={onDetail} />

          <section className="card pad section-card">
            <h3>Files</h3>
            {d.files.length ? <table className="table static compact"><thead><tr><th>File</th><th>What it is</th><th>Added</th><th /></tr></thead>
              <tbody>{d.files.map((f) => (
                <tr key={f.id}><td><a href={`/api/staff/contracts/files/${f.id}`} target="_blank" rel="noreferrer">{f.fileName}</a> <span className="muted small">{fmtSize(f.size)}</span></td>
                  <td>{setup?.fileKinds[f.kind] ?? f.kind}{f.generated && <span className="badge sm" style={{ marginInlineStart: 6 }}>Made by VendorGate · v{f.version}</span>}</td><td className="small">{f.uploadedByName} · {fmtDateTime(f.uploadedAt)}</td>
                  <td className="actions">{manage && (c.status === 'DRAFT' || f.kind !== 'SIGNED') && <button className="link-btn small" onClick={() => confirm(`Remove ${f.fileName}?`) && run(() => api<Detail>(`/staff/contracts/${c.id}/files/${f.id}`, { method: 'DELETE' }), 'File removed.')}>Remove</button>}</td></tr>
              ))}</tbody></table> : <p className="muted small">No files yet.</p>}
            {manage && ['DRAFT', 'APPROVED', 'ACTIVE'].includes(c.status) && setup && <FileUpload kinds={setup.fileKinds} onUpload={upload} defaultKind={(c.status === 'DRAFT' && !d.drafting.draft) || c.status === 'APPROVED' ? (signedCopy ? 'ANNEXURE' : 'SIGNED') : c.status === 'DRAFT' ? 'DRAFT' : 'ANNEXURE'} />}
          </section>

          {(d.parent || d.children.length > 0) && (
            <section className="card pad section-card">
              <h3>Linked contracts</h3>
              {d.parent && <p>Under master agreement <Link to={`/staff/contracts/${d.parent.id}`}>{d.parent.number}</Link> — {d.parent.title}</p>}
              {d.children.length > 0 && <table className="table static compact"><thead><tr><th>Number</th><th>Title</th><th>Status</th><th className="num">Value</th></tr></thead>
                <tbody>{d.children.map((k) => <tr key={k.id}><td className="mono"><Link to={`/staff/contracts/${k.id}`}>{k.number}</Link></td><td>{k.title}</td><td><ContractStatus status={k.status} /></td><td className="num">{k.value === null ? '—' : money(k.value, k.currency)}</td></tr>)}</tbody></table>}
            </section>
          )}
        </div>
        <div>
          <section className="card pad section-card">
            <h3>{KIND_LABEL[d.party.kind]}</h3>
            <p style={{ margin: 0 }}><Link to={`/staff/parties/${d.party.id}`}>{d.party.name}</Link></p>
            {d.party.contacts.filter((x) => x.signatory).length > 0 && <p className="small muted">Signs: {d.party.contacts.filter((x) => x.signatory).map((x) => x.name).join(', ')}</p>}
          </section>
          {d.drafting.approvalOn || d.drafting.approval.steps.length > 0
            ? <FlowPanel flow={d.drafting.approval} onDecide={decide} title="Approval" empty={c.status === 'DRAFT' ? 'Not submitted yet. Who approves depends on the value, the type and whether the wording was changed (Administration → Contracts).' : 'No approval was needed.'} /> : null}
          <HistoryCard rows={d.history} actions={ACTIONS} extra={(h) => (typeof h.detail?.fileName === 'string' ? h.detail.fileName : Array.isArray(h.detail?.fields) ? (h.detail!.fields as string[]).join(', ') : null)} />
        </div>
      </div>

      {modal === 'sign' && <SignModal onClose={() => setModal(null)} onSave={(signedDate) => run(() => api<Detail>(`/staff/contracts/${c.id}/signed`, { body: { signedDate } }), 'Marked as signed.').then((ok) => ok && setModal(null))} />}
      {modal === 'terminate' && <TerminateModal onClose={() => setModal(null)} onSave={(body) => run(() => api<Detail>(`/staff/contracts/${c.id}/terminate`, { body }), 'Contract terminated.').then((ok) => ok && setModal(null))} />}
    </div>
  );
}

function FileUpload({ kinds, defaultKind, onUpload }: { kinds: Record<string, string>; defaultKind: string; onUpload: (kind: string, f: File) => Promise<void> }) {
  const [kind, setKind] = useState(defaultKind);
  useEffect(() => { setKind(defaultKind); }, [defaultKind]);
  return (
    <div className="btn-row" style={{ alignItems: 'end', marginTop: 10 }}>
      <div className="field" style={{ margin: 0 }}><label htmlFor="cf-file-kind">Add a file</label><select id="cf-file-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>Choose Word, PDF or image…<input type="file" accept=".docx,.pdf,.png,.jpg,.jpeg" hidden aria-label="Contract file" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(kind, f); e.target.value = ''; }} /></label>
    </div>
  );
}

function SignModal({ onClose, onSave }: { onClose: () => void; onSave: (date: string) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <Modal title="Mark as signed" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!date} onClick={() => onSave(date)}>Mark as signed</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>The contract becomes active (or expired, if its end date has passed). Its parties, dates and value then change only through an amendment.</p>
      <div className="field"><label htmlFor="sign-date">Signed on</label><input id="sign-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
    </Modal>
  );
}

function TerminateModal({ onClose, onSave }: { onClose: () => void; onSave: (b: { reason: string; effectiveDate: string }) => void }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <Modal title="Terminate the contract" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Keep it</button><button className="btn btn-danger" disabled={reason.trim().length < 5} onClick={() => onSave({ reason, effectiveDate: date })}>Terminate</button></>}>
      <div className="field"><label htmlFor="term-date">Ends on</label><input id="term-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="field"><label htmlFor="term-reason">Reason</label><textarea id="term-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /><div className="field-help">Recorded in the history. This can’t be undone.</div></div>
    </Modal>
  );
}
