/**
 * CSV import of purchase orders: one row per PO line; header values repeat on each row of a PO.
 * Column names are case-insensitive; only PO_NUMBER, SUPPLIER_CODE, LINE_NO, DESCRIPTION,
 * QUANTITY and UNIT_PRICE are required.
 */
import type { CanonicalPoInput } from './model.js';

export const CSV_TEMPLATE_COLUMNS = ['PO_NUMBER', 'ERP_PO_ID', 'REVISION', 'SUPPLIER_CODE', 'ENTITY_CODE', 'ENTITY_NAME', 'BUYING_GROUP', 'BUYER_NAME', 'BUYER_EMAIL',
  'CURRENCY', 'PO_DATE', 'PAYMENT_TERMS', 'INCOTERMS', 'LINE_NO', 'ERP_LINE_ID', 'ITEM_CODE', 'DESCRIPTION', 'UOM', 'QUANTITY', 'UNIT_PRICE', 'TAX_CODE', 'TAX_RATE', 'HSN',
  'SITE_CODE', 'SITE_NAME', 'NEED_BY_DATE', 'TOLERANCE_PCT'] as const;

export const CSV_TEMPLATE_SAMPLE = [
  ['4500012345', '', '0', 'SUP-1001', '101', 'Acme Industries India', 'RAW', 'Priya Shah', 'priya.shah@example.com', 'INR', '2026-10-01', 'Net 45', 'FCA', '1', '', 'RM-10021', 'Microcrystalline cellulose PH-102', 'KG', '500', '182.50', 'GST 18%', '18', '39129090', 'PUN1', 'Pune Plant', '2026-10-20', '5'],
  ['4500012345', '', '0', 'SUP-1001', '101', 'Acme Industries India', 'RAW', 'Priya Shah', 'priya.shah@example.com', 'INR', '2026-10-01', 'Net 45', 'FCA', '2', '', 'PK-20410', 'HDPE bottle 100 cc with CR cap', 'EA', '12000', '6.40', 'GST 18%', '18', '39233090', 'PUN1', 'Pune Plant', '2026-10-25', '2'],
];

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function csvToPurchaseOrders(text: string): { pos: CanonicalPoInput[]; errors: string[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { pos: [], errors: ['The file has no data rows'] };
  const head = rows[0].map((h) => h.trim().toUpperCase().replace(/\s+/g, '_'));
  const col = (r: string[], k: string) => { const i = head.indexOf(k); return i < 0 ? '' : (r[i] ?? '').trim(); };
  const missing = ['PO_NUMBER', 'SUPPLIER_CODE', 'LINE_NO', 'DESCRIPTION', 'QUANTITY', 'UNIT_PRICE'].filter((k) => !head.includes(k));
  if (missing.length) return { pos: [], errors: [`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`] };
  const byPo = new Map<string, CanonicalPoInput>();
  const opt = (v: string) => (v === '' ? undefined : v);
  for (const r of rows.slice(1)) {
    const poNumber = col(r, 'PO_NUMBER');
    const key = col(r, 'ERP_PO_ID') || poNumber;
    let po = byPo.get(key);
    if (!po) {
      po = {
        erpId: key, poNumber, revision: Number(col(r, 'REVISION') || 0), supplierCode: col(r, 'SUPPLIER_CODE'),
        entity: col(r, 'ENTITY_CODE') ? { code: col(r, 'ENTITY_CODE'), name: opt(col(r, 'ENTITY_NAME')) } : undefined,
        buyingGroup: col(r, 'BUYING_GROUP') ? { code: col(r, 'BUYING_GROUP') } : undefined,
        buyer: { name: opt(col(r, 'BUYER_NAME')), email: opt(col(r, 'BUYER_EMAIL')) },
        currency: col(r, 'CURRENCY') || undefined, poDate: opt(col(r, 'PO_DATE')), paymentTerms: opt(col(r, 'PAYMENT_TERMS')), incoterms: opt(col(r, 'INCOTERMS')),
        lines: [],
      };
      byPo.set(key, po);
    }
    const lineNo = col(r, 'LINE_NO');
    po.lines.push({
      erpId: col(r, 'ERP_LINE_ID') || `${key}-${lineNo}`, lineNo: Number(lineNo), itemCode: opt(col(r, 'ITEM_CODE')), description: col(r, 'DESCRIPTION'), uom: opt(col(r, 'UOM')),
      quantity: col(r, 'QUANTITY'), unitPrice: col(r, 'UNIT_PRICE'), taxCode: opt(col(r, 'TAX_CODE')), taxRate: opt(col(r, 'TAX_RATE')), hsn: opt(col(r, 'HSN')),
      site: col(r, 'SITE_CODE') ? { code: col(r, 'SITE_CODE'), name: opt(col(r, 'SITE_NAME')) } : undefined,
      needByDate: opt(col(r, 'NEED_BY_DATE')), tolerancePct: opt(col(r, 'TOLERANCE_PCT')),
    });
  }
  return { pos: [...byPo.values()], errors: [] };
}
