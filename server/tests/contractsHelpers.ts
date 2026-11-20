/** Shared set-up for the contract watch tests: an active supplier contract with an onboarded supplier, and purchase orders. */
import { eq } from 'drizzle-orm';
import { invitedSupplier, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

export const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** An active supplier contract with an onboarded supplier, owned by the admin. */
export async function activeContract(name: string, fields: Partial<typeof schema.contracts.$inferInsert>, contacts: { name: string; email: string; signatory?: boolean }[] = []) {
  const admin = await login('admin@acme.test');
  const { id: vendorId } = await invitedSupplier(name, `${name.toLowerCase().replace(/\W+/g, '')}@watch.example`);
  const party = (await admin.post('/api/staff/parties/from-supplier', { vendorId })).body.party;
  if (contacts.length) await db.update(schema.parties).set({ contacts }).where(eq(schema.parties.id, party.id));
  const me = (await admin.get('/api/auth/me')).body.user;
  const c = (await admin.post('/api/staff/contracts', { title: `${name} contract`, direction: 'BUY', type: 'supply', partyId: party.id, value: 100000, currency: 'INR', startDate: iso(-300), endDate: iso(365), ownerId: me.id })).body.contract;
  await db.update(schema.contracts).set({ status: 'ACTIVE', signedDate: iso(-300), ...fields }).where(eq(schema.contracts.id, c.id));
  const vendor = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, vendorId) }))!;
  return { id: c.id as string, number: c.number as string, vendorId, vendorCode: vendor.code, partyId: party.id as string, admin, me };
}

/** A purchase order as the ERP sends it. */
export const po = (code: string, n: string, lines: { item: string; qty: number; price: number }[], poDate = iso(-10)) => ({
  erpId: `W-${n}`, poNumber: `W-${n}`, supplierCode: code, currency: 'INR', poDate,
  lines: lines.map((l, i) => ({ erpId: `W-${n}-${i + 1}`, lineNo: i + 1, itemCode: l.item, description: l.item, quantity: l.qty, unitPrice: l.price })),
});

/** A Word contract with the given paragraphs (for reading tests). */
export async function wordFile(lines: string[]) {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  return Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: lines.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] })));
}
/** A tiny PDF (no text — reads as a scan). */
export const PDF_BYTES = (tag = '') => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
