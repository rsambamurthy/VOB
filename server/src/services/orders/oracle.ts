/**
 * Oracle E-Business Suite purchase orders ⇄ the canonical model.
 *
 * Inbound: the shape a REST service over PO_HEADERS_ALL / PO_LINES_ALL / PO_LINE_LOCATIONS_ALL /
 * RCV_TRANSACTIONS typically returns (Integrated SOA Gateway or middleware), one object per PO with
 * nested LINES → SHIPMENTS and optional RECEIPTS. Column names follow the EBS tables.
 *
 * Outbound: a supplier acknowledgement per PO, for the middleware to record (PO_ACCEPTANCES).
 */
import type { PoLine, PurchaseOrder } from '../../db/schema.js';
import type { CanonicalPoInput } from './model.js';

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v).trim());
const d = (v: unknown) => { const x = s(v); return x ? x.slice(0, 10) : undefined; };
const n = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);
const pick = (o: Row, ...keys: string[]) => { for (const k of keys) { const v = o[k] ?? o[k.toLowerCase()]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };

/** Oracle CLOSED_CODE / CANCEL_FLAG → OPEN | CLOSED | CANCELLED */
function status(o: Row): 'OPEN' | 'CLOSED' | 'CANCELLED' {
  if (s(pick(o, 'CANCEL_FLAG')) === 'Y') return 'CANCELLED';
  const c = (s(pick(o, 'CLOSED_CODE')) ?? 'OPEN').toUpperCase();
  return c === 'OPEN' || c.startsWith('CLOSED FOR') ? 'OPEN' : 'CLOSED'; // "CLOSED FOR RECEIVING/INVOICE" is still open for the supplier
}

export function oracleToCanonical(h: Row): CanonicalPoInput {
  const lines = arr(pick(h, 'LINES', 'PO_LINES'));
  const vendorNum = s(pick(h, 'VENDOR_NUM', 'SUPPLIER_NUMBER', 'SEGMENT1_VENDOR'));
  const vendorId = s(pick(h, 'VENDOR_ID'));
  const firstCategory = lines.length ? s(pick(lines[0], 'CATEGORY', 'CATEGORY_NAME')) : undefined;
  const group = s(pick(h, 'BUYING_GROUP', 'PURCHASING_GROUP', 'DOCUMENT_SUBTYPE')) ?? firstCategory?.split('.')[0];
  return {
    erpId: s(pick(h, 'PO_HEADER_ID'))!,
    poNumber: s(pick(h, 'SEGMENT1', 'PO_NUMBER'))!,
    revision: n(pick(h, 'REVISION_NUM')) ?? 0,
    supplierCode: (vendorNum ?? vendorId)!,
    supplierAltCodes: vendorNum && vendorId ? [vendorId] : undefined,
    supplierSiteCode: s(pick(h, 'VENDOR_SITE_CODE', 'VENDOR_SITE_ID')),
    entity: pick(h, 'ORG_ID') !== undefined ? { code: s(pick(h, 'ORG_ID'))!, name: s(pick(h, 'OPERATING_UNIT', 'ORG_NAME')) } : undefined,
    buyingGroup: group ? { code: group } : undefined,
    buyer: { name: s(pick(h, 'AGENT_NAME', 'BUYER_NAME')), email: s(pick(h, 'AGENT_EMAIL', 'BUYER_EMAIL')) },
    poType: s(pick(h, 'TYPE_LOOKUP_CODE')),
    currency: s(pick(h, 'CURRENCY_CODE')) ?? 'INR',
    poDate: d(pick(h, 'APPROVED_DATE', 'CREATION_DATE')),
    paymentTerms: s(pick(h, 'TERMS', 'PAYMENT_TERMS', 'TERMS_NAME')),
    incoterms: s(pick(h, 'FOB_LOOKUP_CODE', 'FREIGHT_TERMS_LOOKUP_CODE', 'INCOTERMS')),
    notes: s(pick(h, 'COMMENTS', 'NOTE_TO_VENDOR')),
    status: status(h),
    attachments: arr(pick(h, 'ATTACHMENTS')).map((a) => ({ name: s(pick(a, 'TITLE', 'FILE_NAME', 'NAME')) ?? 'Attachment', url: s(pick(a, 'URL'))! })).filter((a) => a.url),
    lines: lines.map((l) => {
      const ships = arr(pick(l, 'SHIPMENTS', 'LINE_LOCATIONS'));
      const first = ships[0] ?? {};
      const sum = (k: string) => (ships.length ? ships.reduce((t, x) => t + (n(pick(x, k)) ?? 0), 0) : n(pick(l, k)));
      const item = s(pick(l, 'ITEM_NUMBER', 'ITEM_CODE'));
      const siteCode = s(pick(first, 'SHIP_TO_ORGANIZATION_CODE', 'SHIP_TO_ORGANIZATION_ID')) ?? s(pick(l, 'SHIP_TO_ORGANIZATION_CODE'));
      const qty = n(pick(l, 'QUANTITY')) ?? 0, price = n(pick(l, 'UNIT_PRICE')) ?? 0;
      const lineType = s(pick(l, 'LINE_TYPE', 'ORDER_TYPE_LOOKUP_CODE'))?.toUpperCase();
      return {
        erpId: s(pick(l, 'PO_LINE_ID'))!,
        lineNo: n(pick(l, 'LINE_NUM')) ?? 0,
        itemCode: item,
        description: s(pick(l, 'ITEM_DESCRIPTION', 'DESCRIPTION')) ?? item ?? 'Line',
        uom: s(pick(l, 'UNIT_MEAS_LOOKUP_CODE', 'UOM_CODE')),
        quantity: qty,
        unitPrice: price,
        amount: n(pick(l, 'AMOUNT')) ?? Math.round(qty * price * 100) / 100,
        taxCode: s(pick(l, 'TAX_NAME', 'TAX_CODE')),
        taxRate: n(pick(l, 'TAX_RATE')),
        hsn: s(pick(l, 'HSN_CODE', 'HSN_SAC')),
        site: siteCode ? { code: siteCode, name: s(pick(first, 'SHIP_TO_ORGANIZATION_NAME')) } : undefined,
        needByDate: d(pick(first, 'NEED_BY_DATE')) ?? d(pick(l, 'NEED_BY_DATE')),
        promisedDate: d(pick(first, 'PROMISED_DATE')) ?? d(pick(l, 'PROMISED_DATE')),
        tolerancePct: n(pick(first, 'QTY_RCV_TOLERANCE')),
        receivedQty: sum('QUANTITY_RECEIVED') ?? 0,
        billedQty: sum('QUANTITY_BILLED') ?? 0,
        status: status(l),
        lineType: lineType?.includes('SERVICE') || lineType === 'AMOUNT' || lineType === 'FIXED PRICE' ? 'SERVICE' : item ? 'GOODS' : 'SERVICE',
      };
    }),
    receipts: arr(pick(h, 'RECEIPTS', 'RCV_TRANSACTIONS')).map((r) => ({
      erpId: s(pick(r, 'TRANSACTION_ID', 'SHIPMENT_LINE_ID'))!,
      lineErpId: s(pick(r, 'PO_LINE_ID')),
      receiptNumber: s(pick(r, 'RECEIPT_NUM'))!,
      receiptDate: d(pick(r, 'TRANSACTION_DATE')),
      quantity: n(pick(r, 'QUANTITY')) ?? 0,
    })),
  };
}

/** Accepts one PO, an array, or the common wrappers ({ items }, { PurchaseOrders }, { data }). */
export function oracleList(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  if (body && typeof body === 'object') {
    for (const k of ['items', 'PurchaseOrders', 'PURCHASE_ORDERS', 'data', 'PO_HEADERS']) { const v = (body as Row)[k]; if (Array.isArray(v)) return v as Row[]; }
    if ('PO_HEADER_ID' in (body as Row)) return [body as Row];
  }
  return [];
}

/** The acknowledgement Oracle middleware receives when a supplier (or the system) accepts. */
export function oracleAcknowledgement(po: PurchaseOrder, lines: PoLine[], a: { by: string; auto: boolean; note?: string | null; entityCode?: string | null }) {
  return {
    PO_HEADER_ID: po.erpId,
    SEGMENT1: po.poNumber,
    REVISION_NUM: po.revision,
    ORG_ID: a.entityCode ?? undefined,
    ACCEPTED_FLAG: 'Y',
    ACCEPTANCE_TYPE: a.auto ? 'AUTO_ACCEPTED' : 'ACCEPTED',
    ACCEPTED_BY: a.by,
    ACTION_DATE: new Date().toISOString(),
    NOTE: a.note ?? undefined,
    LINES: lines.map((l) => ({ PO_LINE_ID: l.erpId, LINE_NUM: l.lineNo, ACCEPTED_FLAG: 'Y', PROMISED_DATE: l.promisedDate ?? l.needByDate ?? undefined })),
  };
}
