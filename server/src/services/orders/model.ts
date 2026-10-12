/**
 * The canonical purchase order: every source (Oracle EBS, the REST API, CSV, the demo ERP) is
 * turned into this shape before import, so the rest of the system never sees ERP-specific fields.
 */
import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Dates must be YYYY-MM-DD').transform((s) => s.slice(0, 10));
const num = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'must be a number')]).transform((v) => Number(v));
const code = z.string().trim().min(1).max(100);
const ref = z.object({ code, name: z.string().trim().max(200).optional() });

export const canonicalLine = z.object({
  erpId: code,
  lineNo: z.coerce.number().int().positive(),
  itemCode: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().min(1).max(1000),
  uom: z.string().trim().max(30).optional().nullable(),
  quantity: num,
  unitPrice: num,
  amount: num.optional(),
  taxCode: z.string().trim().max(60).optional().nullable(),
  taxRate: num.optional().nullable(),
  hsn: z.string().trim().max(20).optional().nullable(),
  site: ref.optional().nullable(),
  needByDate: date.optional().nullable(),
  promisedDate: date.optional().nullable(),
  tolerancePct: num.optional().nullable(),
  receivedQty: num.optional(),
  billedQty: num.optional(),
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
  /** GOODS or SERVICE; defaults to GOODS when there's an item code, SERVICE otherwise. */
  lineType: z.enum(['GOODS', 'SERVICE']).optional(),
});

export const canonicalReceipt = z.object({
  erpId: code,
  lineErpId: code.optional().nullable(),
  receiptNumber: code,
  receiptDate: date.optional().nullable(),
  quantity: num,
});

export const canonicalPo = z.object({
  erpId: code,
  poNumber: code,
  revision: z.coerce.number().int().min(0).default(0),
  supplierCode: code,
  /** Other identifiers the supplier has in the ERP (e.g. Oracle VENDOR_ID besides the supplier number). */
  supplierAltCodes: z.array(code).optional(),
  supplierSiteCode: z.string().trim().max(100).optional().nullable(),
  entity: ref.optional().nullable(),
  buyingGroup: ref.optional().nullable(),
  buyer: z.object({ name: z.string().trim().max(200).optional().nullable(), email: z.string().trim().email().optional().nullable() }).optional().nullable(),
  poType: z.string().trim().max(60).optional().nullable(),
  currency: z.string().trim().length(3).default('INR'),
  poDate: date.optional().nullable(),
  paymentTerms: z.string().trim().max(200).optional().nullable(),
  incoterms: z.string().trim().max(200).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).default('OPEN'),
  attachments: z.array(z.object({ name: z.string().max(200), url: z.string().url().max(2000) })).max(50).optional(),
  lines: z.array(canonicalLine).min(1, 'A purchase order needs at least one line').max(2000),
  receipts: z.array(canonicalReceipt).max(5000).optional(),
});

export type CanonicalPo = z.infer<typeof canonicalPo>;
export type CanonicalLine = z.infer<typeof canonicalLine>;
export type CanonicalPoInput = z.input<typeof canonicalPo>;
