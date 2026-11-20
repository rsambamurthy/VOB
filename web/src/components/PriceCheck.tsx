/** Order and invoice lines checked against the supplier's contract prices (Contracts → agreed prices). Staff screens only. */
import { Link } from 'react-router-dom';
import { money } from '../lib/format';

export interface PriceCheck { tolerance: number; above: number; lines: { key: string; status: 'OK' | 'ABOVE' | 'NO_PRICE'; contractPrice: number | null; contract: { id: string; number: string } | null; diffPct: number | null }[] }

export function PriceCheckCard({ check, lines, currency }: { check: PriceCheck | null | undefined; lines: { key: string; label: string; unitPrice: number }[]; currency: string }) {
  if (!check) return null;
  const rows = check.lines.filter((l) => l.status !== 'NO_PRICE');
  if (!rows.length) return null;
  return (
    <section className="card section-card" aria-label="Contract prices">
      <div className="toolbar"><h3>Contract prices</h3>
        <span className={`badge sm ${check.above ? 'badge-rejected' : 'badge-approved'}`}>{check.above ? `${check.above} line${check.above === 1 ? '' : 's'} above the contract price` : 'Within the contract prices'}</span></div>
      <table className="table static compact"><thead><tr><th>Line</th><th className="num">Price here</th><th className="num">Contract price</th><th className="num">Difference</th><th>Contract</th></tr></thead>
        <tbody>{rows.map((r) => { const l = lines.find((x) => x.key === r.key); return (
          <tr key={r.key}><td>{l?.label}</td><td className="num">{l ? money(l.unitPrice, currency) : ''}</td><td className="num">{money(r.contractPrice ?? 0, currency)}</td>
            <td className="num"><span className={r.status === 'ABOVE' ? 'badge sm badge-rejected' : ''}>{r.diffPct! > 0 ? '+' : ''}{r.diffPct}%</span></td>
            <td className="mono small">{r.contract && <Link to={`/staff/contracts/${r.contract.id}`}>{r.contract.number}</Link>}</td></tr>); })}</tbody></table>
      {check.tolerance > 0 && <p className="muted small" style={{ padding: '0 16px' }}>Up to {check.tolerance}% above the contract price is accepted.</p>}
    </section>
  );
}
