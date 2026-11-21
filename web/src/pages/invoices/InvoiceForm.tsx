/**
 * The AP entry form — one form for new invoices, credit and debit notes and drafts being finished (bulk upload and Excel
 * drafts open here too). Saving keeps a draft; the server checks it (services/invoices/checks.ts) and returns the checks.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { BASIS_LABEL, blankLine, CODE_LIST, CodeLists, KIND_LABEL, lineTotal, LinesEditor, type ApDetail, type Basis, type InvKind, type InvoiceSetup, type Line } from '../../components/Invoices';

export interface Draft {
  kind: InvKind; partyId: string; basis: Basis; poId: string; contractId: string; relatedInvoiceId: string;
  invoiceNumber: string; invoiceDate: string; glDate: string; dueDate: string; currency: string; total: number; description: string; entityCode: string; notes: string; lines: Line[];
}
interface PoLine { lineId: string; lineNo: number; itemCode: string | null; description: string; uom: string | null; ordered: number; received: number; unitPrice: number; taxRate: number | null; available: number; availableReceived: number }
interface ForNote { id: string; invoiceNumber: string; invoiceDate: string; total: number; currency: string; status: string; poId: string | null; contractId: string | null }

const today = () => new Date().toISOString().slice(0, 10);
export const blankDraft = (kind: InvKind, setup: InvoiceSetup): Draft => ({
  kind, partyId: '', basis: kind === 'INVOICE' ? (setup.settings.bases.includes('nonPo') ? 'nonPo' : setup.settings.bases[0] ?? 'po') : 'nonPo', poId: '', contractId: '', relatedInvoiceId: '',
  invoiceNumber: '', invoiceDate: today(), glDate: '', dueDate: '', currency: setup.currency, total: 0, description: '', entityCode: '', notes: '', lines: kind === 'INVOICE' ? [blankLine()] : [],
});
export function draftFrom(d: ApDetail): Draft {
  const i = d.invoice;
  return {
    kind: i.kind, partyId: i.partyId ?? '', basis: i.basis, poId: i.poId ?? '', contractId: i.contractId ?? '', relatedInvoiceId: i.relatedInvoiceId ?? '', invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate,
    glDate: i.glDate ?? '', dueDate: i.dueDate ?? '', currency: i.currency, total: i.total, description: i.description ?? '', entityCode: i.entityCode ?? '', notes: i.notes ?? '', lines: d.lines,
  };
}
export const draftBody = (v: Draft) => ({
  kind: v.kind, partyId: v.partyId, poId: v.kind === 'INVOICE' && v.basis === 'po' ? v.poId : null, contractId: v.kind === 'INVOICE' && v.basis === 'contract' ? v.contractId : null,
  relatedInvoiceId: v.kind === 'INVOICE' ? null : v.relatedInvoiceId || null, invoiceNumber: v.invoiceNumber, invoiceDate: v.invoiceDate, glDate: v.glDate || null, dueDate: v.dueDate || null,
  currency: v.currency, total: v.total, description: v.description || null, entityCode: v.entityCode || null, notes: v.notes || null,
  lines: v.lines.filter((l) => !l.lineId || l.quantity > 0).map((l) => ({ lineId: l.lineId ?? null, itemCode: l.itemCode, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
    glAccount: l.glAccount, costCentre: l.costCentre, project: l.project, task: l.task })),
});

export function InvoiceForm({ value, onChange, setup, fixedParty }: { value: Draft; onChange: (d: Draft) => void; setup: InvoiceSetup; fixedParty?: boolean }) {
  const [parties, setParties] = useState<{ id: string; name: string; code: string }[]>([]);
  const [orders, setOrders] = useState<{ id: string; poNumber: string; poDate: string | null; total: number; currency: string }[]>([]);
  const [contracts, setContracts] = useState<{ id: string; number: string; title: string; currency: string }[]>([]);
  const [forNotes, setForNotes] = useState<ForNote[]>([]);
  const v = value;
  const set = <K extends keyof Draft>(k: K, x: Draft[K]) => onChange({ ...v, [k]: x });
  const note = v.kind !== 'INVOICE';
  const related = forNotes.find((x) => x.id === v.relatedInvoiceId);
  const poId = note ? related?.poId ?? '' : v.basis === 'po' ? v.poId : '';
  const poLines = !!poId;

  useEffect(() => { api<{ parties: typeof parties }>('/staff/parties/options?kind=SUPPLIER').then((r) => setParties(r.parties)).catch(() => {}); }, []);
  useEffect(() => {
    if (!v.partyId) { setOrders([]); setContracts([]); setForNotes([]); return; }
    const q = `partyId=${encodeURIComponent(v.partyId)}`;
    if (note) api<{ invoices: ForNote[] }>(`/staff/invoices/for-notes?${q}`).then((r) => setForNotes(r.invoices)).catch(() => {});
    else {
      if (setup.settings.bases.includes('po')) api<{ orders: typeof orders }>(`/staff/invoices/orders?${q}`).then((r) => setOrders(r.orders)).catch(() => {});
      if (setup.settings.bases.includes('contract')) api<{ contracts: typeof contracts }>(`/staff/invoices/contracts?${q}`).then((r) => setContracts(r.contracts)).catch(() => {});
    }
  }, [v.partyId, note, setup.settings.bases]);
  // PO lines: every invoiceable line, with what this draft already has on it.
  useEffect(() => {
    if (!poId) return;
    api<{ lines: PoLine[] }>(`/staff/invoices/orders/${poId}/lines`).then((r) => {
      const had = new Map(v.lines.filter((l) => l.lineId).map((l) => [l.lineId!, l]));
      onChange({ ...v, lines: r.lines.map((p) => {
        const h = had.get(p.lineId);
        return { lineId: p.lineId, lineNo: p.lineNo, itemCode: p.itemCode, description: p.description, uom: p.uom, ordered: p.ordered, received: p.received, poPrice: p.unitPrice,
          quantity: h ? h.quantity : 0, unitPrice: h ? h.unitPrice : p.unitPrice, taxRate: h ? h.taxRate : p.taxRate, glAccount: null, costCentre: null, project: null, task: null };
      }) });
    }).catch(() => {});
  }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  const linesTotal = Math.round(v.lines.reduce((t, l) => t + lineTotal(l), 0) * 100) / 100;

  return (
    <>
      <CodeLists setup={setup} />
      <div className="field-grid">
        <div className="field"><label htmlFor="if-party">Supplier</label>
          <select id="if-party" disabled={fixedParty} value={v.partyId} onChange={(e) => onChange({ ...v, partyId: e.target.value, poId: '', contractId: '', relatedInvoiceId: '', lines: note ? [] : v.lines.filter((l) => !l.lineId) })}>
            <option value="">Choose…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select></div>
        {!note && setup.settings.bases.length > 1 && (
          <div className="field"><label htmlFor="if-basis">Against</label>
            <select id="if-basis" value={v.basis} onChange={(e) => onChange({ ...v, basis: e.target.value as Basis, poId: '', contractId: '', lines: e.target.value === 'po' ? [] : [blankLine()] })}>
              {setup.settings.bases.map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}</select></div>)}
        {!note && v.basis === 'po' && (
          <div className="field"><label htmlFor="if-po">Purchase order</label>
            <select id="if-po" value={v.poId} onChange={(e) => onChange({ ...v, poId: e.target.value, lines: [] })}>
              <option value="">{v.partyId && !orders.length ? 'No orders for this supplier' : 'Choose…'}</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.poNumber} · {money(o.total, o.currency)}</option>)}</select></div>)}
        {!note && v.basis === 'contract' && (
          <div className="field"><label htmlFor="if-contract">Contract</label>
            <select id="if-contract" value={v.contractId} onChange={(e) => onChange({ ...v, contractId: e.target.value, currency: contracts.find((c) => c.id === e.target.value)?.currency ?? v.currency })}>
              <option value="">{v.partyId && !contracts.length ? 'No signed contracts with this supplier' : 'Choose…'}</option>{contracts.map((c) => <option key={c.id} value={c.id}>{c.number} · {c.title}</option>)}</select></div>)}
        {note && (
          <div className="field"><label htmlFor="if-rel">Against invoice</label>
            <select id="if-rel" value={v.relatedInvoiceId} onChange={(e) => { const r = forNotes.find((x) => x.id === e.target.value); onChange({ ...v, relatedInvoiceId: e.target.value, currency: r?.currency ?? v.currency, lines: r?.poId ? [] : v.lines.length ? v.lines : [blankLine()] }); }}>
              <option value="">Choose…</option>{forNotes.map((x) => <option key={x.id} value={x.id}>{x.invoiceNumber} · {money(x.total, x.currency)}</option>)}</select></div>)}
        <div className="field"><label htmlFor="if-num">{KIND_LABEL[v.kind]} number</label>
          <input id="if-num" value={v.invoiceNumber} placeholder={v.kind === 'DEBIT' ? 'Given when saved (DN-…)' : 'As on the supplier’s document'} disabled={v.kind === 'DEBIT'} onChange={(e) => set('invoiceNumber', e.target.value)} /></div>
        <div className="field"><label htmlFor="if-date">{KIND_LABEL[v.kind]} date</label><input id="if-date" type="date" value={v.invoiceDate} onChange={(e) => set('invoiceDate', e.target.value)} /></div>
        <div className="field"><label htmlFor="if-gl">GL date (optional)</label><input id="if-gl" type="date" value={v.glDate} onChange={(e) => set('glDate', e.target.value)} /></div>
        {!note && <div className="field"><label htmlFor="if-due">Due date (optional)</label><input id="if-due" type="date" value={v.dueDate} onChange={(e) => set('dueDate', e.target.value)} /><div className="field-help">Empty = from the payment terms.</div></div>}
        <div className="field"><label htmlFor="if-cur">Currency</label><input id="if-cur" maxLength={3} value={v.currency} disabled={note || poLines} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></div>
        {!note && <div className="field"><label htmlFor="if-ent">Operating unit</label><input id="if-ent" list={CODE_LIST.ENTITY} value={v.entityCode} onChange={(e) => set('entityCode', e.target.value)} /></div>}
        <div className="field"><label htmlFor="if-total">Total on the document</label><input id="if-total" inputMode="decimal" value={v.total} onChange={(e) => set('total', e.target.value === '' ? 0 : Number(e.target.value))} />
          {v.lines.length > 0 && Math.abs(linesTotal - v.total) > 1 && <div className="field-help warn-text">The lines come to {money(linesTotal, v.currency)}.</div>}</div>
        <div className="field field-wide"><label htmlFor="if-desc">Description</label><input id="if-desc" value={v.description} maxLength={500} placeholder={v.kind === 'DEBIT' ? 'Why — e.g. short supply, price difference, rejected goods' : 'e.g. Warehouse rent — November'} onChange={(e) => set('description', e.target.value)} /></div>
      </div>
      {(poLines || !(v.basis === 'po' && !note)) && (v.lines.length > 0 || !poLines) && (
        <section className="section-card" aria-label="Lines">
          <h4>{poLines ? (note ? 'Order lines this note is for' : 'Order lines invoiced') : 'Lines'}</h4>
          {poLines && <p className="muted small">Enter the quantity on the {KIND_LABEL[v.kind].toLowerCase()} for each line; lines left at 0 are not included.</p>}
          <LinesEditor lines={v.lines} onChange={(lines) => set('lines', lines)} currency={v.currency} po={poLines} setup={setup} />
        </section>
      )}
      <div className="field"><label htmlFor="if-notes">Notes for approvers (optional)</label><textarea id="if-notes" rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></div>
    </>
  );
}
