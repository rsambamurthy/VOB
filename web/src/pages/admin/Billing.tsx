import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { fmtDate } from '../../lib/format';

export interface InvoiceRow {
  id: string; number: string; status: 'DUE' | 'PAID' | 'VOID'; planLabel: string; cycle: string; periodStart: string; periodEnd: string; issuedAt: string; dueAt: string;
  currency: string; subtotal: number; tax: number; total: number; paidAt: string | null; paymentMethod: string | null; paymentRef: string | null; payUrl: string | null; overdue: boolean; activatesPlan: boolean;
}
export interface BillingDetails { legalName?: string; gstin?: string; address?: string; city?: string; postalCode?: string; country?: string; stateCode?: string; email?: string; cycle?: 'monthly' | 'yearly'; nextInvoiceOn?: string; autoInvoice?: boolean }
interface Data {
  plan: string; planLabel: string; trialEndsAt: string | null; billing: BillingDetails; currency: string; gstRate: number;
  prices: Record<string, { monthly: number | null; yearly: number | null }>; invoices: InvoiceRow[]; online: boolean; testPay: boolean; problems: string[]; sellerReady: boolean;
  states: { code: string; name: string }[]; countries: { code: string; name: string }[];
}

export const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const major = (v: number | null, currency: string) => (v === null ? '—' : `${currency} ${v.toLocaleString('en-IN')}`);

export function InvoiceStatus({ i }: { i: InvoiceRow }) {
  if (i.status === 'PAID') return <span className="badge badge-approved sm">Paid {fmtDate(i.paidAt)}</span>;
  if (i.status === 'VOID') return <span className="badge sm">Cancelled</span>;
  return <span className={`badge sm ${i.overdue ? 'badge-rejected' : 'badge-invited'}`}>{i.overdue ? 'Overdue' : `Due ${fmtDate(i.dueAt)}`}</span>;
}

/** Billing details form, shared with the platform console. */
export function BillingForm({ value, states, countries, onSave, saveLabel = 'Save billing details' }: { value: BillingDetails; states: Data['states']; countries: Data['countries']; onSave: (v: BillingDetails) => Promise<void>; saveLabel?: string }) {
  const [f, setF] = useState<BillingDetails>({ country: 'IN', ...value });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof BillingDetails) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const india = (f.country ?? 'IN') === 'IN';
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(f); } finally { setBusy(false); } }}>
      <div className="field-grid">
        <div className="field"><label htmlFor="b-name">Legal name to invoice</label><input id="b-name" required value={f.legalName ?? ''} onChange={set('legalName')} /></div>
        <div className="field"><label htmlFor="b-email">Billing email</label><input id="b-email" type="email" required value={f.email ?? ''} onChange={set('email')} placeholder="accounts@yourcompany.com" /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="b-addr">Billing address</label><textarea id="b-addr" rows={2} required value={f.address ?? ''} onChange={set('address')} /></div>
        <div className="field"><label htmlFor="b-city">City</label><input id="b-city" value={f.city ?? ''} onChange={set('city')} /></div>
        <div className="field"><label htmlFor="b-pin">Postal code</label><input id="b-pin" value={f.postalCode ?? ''} onChange={set('postalCode')} /></div>
        <div className="field"><label htmlFor="b-country">Country</label><select id="b-country" value={f.country ?? 'IN'} onChange={set('country')}>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
        {india && <div className="field"><label htmlFor="b-state">State (GST place of supply)</label><select id="b-state" value={f.stateCode ?? ''} onChange={set('stateCode')}><option value="">Choose…</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}</select></div>}
        {india && <div className="field"><label htmlFor="b-gstin">GSTIN (optional)</label><input id="b-gstin" value={f.gstin ?? ''} maxLength={15} onChange={set('gstin')} placeholder="For input tax credit" /><div className="field-help">With a GSTIN the state is taken from it.</div></div>}
        {!india && <div className="field"><p className="small muted" style={{ marginTop: 24 }}>Invoiced in US dollars as an export of services (no Indian GST).</p></div>}
      </div>
      <div><button className="btn btn-secondary" disabled={busy}>{busy ? 'Saving…' : saveLabel}</button></div>
    </form>
  );
}

export function Billing() {
  const { refresh } = useSession();
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState<Data>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('yearly');
  const [busy, setBusy] = useState(false);
  const load = () => api<Data>('/admin/billing').then((r) => { setD(r); if (r.billing.cycle) setCycle(r.billing.cycle); }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (params.get('paid')) { setMsg({ kind: 'success', text: 'Thank you — your payment is being confirmed. This page updates once the payment provider tells us.' }); setParams({}, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="page"><div className="spinner" />{msg && <Alert kind={msg.kind}>{msg.text}</Alert>}</div>;
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); setMsg(undefined); try { await fn(); await load(); await refresh(); if (ok) setMsg({ kind: 'success', text: ok }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); } };
  const pending = d.invoices.find((i) => i.status === 'DUE' && i.activatesPlan);
  const std = d.prices.standard;
  const pay = (i: InvoiceRow) => (i.payUrl ? <a className="btn btn-primary btn-sm" href={i.payUrl} target="_blank" rel="noreferrer">Pay now</a>
    : d.testPay ? <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => api(`/admin/billing/invoices/${i.id}/test-pay`, { method: 'POST' }), `Invoice ${i.number} marked paid (test mode).`)}>Pay (test)</button>
      : <span className="small muted">Pay by bank transfer — see the invoice</span>);

  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>Billing</h1><p className="muted">Your plan, billing details and invoices.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <section className="card pad section-card">
        <h3>Plan</h3>
        <p><strong>{d.planLabel}</strong>{d.plan === 'trial' && d.trialEndsAt && <> — free trial until {fmtDate(d.trialEndsAt)}</>}{d.plan !== 'trial' && d.billing.cycle && <> · billed {d.billing.cycle}{d.billing.nextInvoiceOn && <>, next invoice {fmtDate(d.billing.nextInvoiceOn)}</>}</>}</p>
        {d.plan === 'trial' && (
          !d.sellerReady ? <p className="small muted">Online upgrades aren’t open yet — contact us to choose a plan.</p>
            : !std.monthly && !std.yearly ? <p className="small muted">Contact us for pricing.</p>
            : pending ? (
              <div className="action-bar"><span>Invoice <strong>{pending.number}</strong> for {money(pending.total, pending.currency)} — the Standard plan starts as soon as it is paid.</span>{pay(pending)}</div>
            ) : (
              <>
                <div className="radio-row">
                  {std.monthly && <label className="radio"><input type="radio" checked={cycle === 'monthly'} onChange={() => setCycle('monthly')} /> Monthly — {major(std.monthly, d.currency)}</label>}
                  {std.yearly && <label className="radio"><input type="radio" checked={cycle === 'yearly'} onChange={() => setCycle('yearly')} /> Yearly — {major(std.yearly, d.currency)}</label>}
                </div>
                <p className="small muted">Prices exclude GST{d.currency === 'INR' ? ` (${d.gstRate}%)` : ''}. Standard: 25 users, 1,000 suppliers, ERP integration and AI document reading.</p>
                {d.problems.length ? <Alert kind="info">Fill in your billing details below first.</Alert>
                  : <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api('/admin/billing/upgrade', { body: { cycle } }), 'Invoice ready — pay it to start the Standard plan.')}>Upgrade to Standard</button>}
              </>
            ))}
      </section>

      <section className="card pad section-card">
        <h3>Billing details</h3>
        <p className="muted small">Printed on your tax invoices. Invoices go to the billing email.</p>
        <BillingForm value={d.billing} states={d.states} countries={d.countries} onSave={(v) => run(() => api('/admin/billing/details', { method: 'PUT', body: v }), 'Billing details saved.')} />
      </section>

      <section className="card pad section-card">
        <h3>Invoices</h3>
        {d.invoices.length ? (
          <div className="table-wrap"><table className="table static">
            <thead><tr><th>Invoice</th><th>Period</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>{d.invoices.map((i) => (
              <tr key={i.id}>
                <td><span className="mono nowrap">{i.number}</span><div className="muted small">{i.planLabel} · {i.cycle}</div></td>
                <td className="small">{fmtDate(i.periodStart)} – {fmtDate(new Date(new Date(i.periodEnd).getTime() - 86_400_000).toISOString())}</td>
                <td className="num">{money(i.total, i.currency)}<div className="muted small">incl. tax {money(i.tax, i.currency)}</div></td>
                <td><InvoiceStatus i={i} /></td>
                <td className="actions"><a className="link-btn small" href={`/api/admin/billing/invoices/${i.id}/pdf`}>PDF</a> {i.status === 'DUE' && pay(i)}</td>
              </tr>))}</tbody>
          </table></div>
        ) : <p className="muted small">No invoices yet.</p>}
      </section>
    </div>
  );
}
