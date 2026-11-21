/**
 * What suppliers hear about invoices: decisions on their portal invoices (English / Arabic templates), and debit notes —
 * emailed with the PDF when the workspace's setting says so (automatically, AP's choice per note, or never).
 */
import PDFDocument from 'pdfkit';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { SupplierInvoice, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { registerAttachment } from '../../integrations/email/index.js';
import { langForVendorId, mailDate, mailSupplier, snippet } from '../../i18n/emails.js';
import { supplierLink, supplierRecipients } from '../orders/importer.js';
import { companyDetails } from '../contracts/config.js';
import { amountInWords } from '../contracts/fields.js';
import { invoiceRules } from './config.js';
import type { By } from './record.js';

const { supplierInvoices, supplierInvoiceLines, parties, purchaseOrders } = schema;

/** Portal invoices: the supplier is told the decision (rejections with the reason). */
export async function tellSupplier(t: Tenant, inv: SupplierInvoice, decision: 'APPROVED' | 'REJECTED', note: string | null) {
  if (!inv.vendorId || inv.source !== 'PORTAL') return;
  const po = inv.poId ? await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId), columns: { poNumber: true } }) : undefined;
  const lang = await langForVendorId(inv.vendorId);
  const due = inv.dueDate ? snippet(lang, 'invoiceDue', { date: lang === 'ar' ? mailDate(inv.dueDate, lang) : inv.dueDate }) : '';
  for (const r of await supplierRecipients(inv.vendorId)) {
    await mailSupplier(lang, { tenantId: t.id, to: r.email, link: supplierLink(t, `/vendor/invoices/${inv.id}`) }, decision === 'APPROVED' ? 'invoiceApproved' : 'invoiceRejected',
      { name: r.name, buyer: t.name, inv: inv.invoiceNumber, amount: `${inv.currency} ${inv.total}`, po: po?.poNumber ?? '', due, reason: note }).catch(() => {});
  }
}

/* ---------------- debit notes ---------------- */

const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The debit note as a PDF: our company, the supplier, the invoice it is against, reason, lines, tax, total in words. */
export async function debitNotePdf(invoiceId: string): Promise<Buffer> {
  const dn = await db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, invoiceId) });
  if (!dn || dn.kind !== 'DEBIT') throw new HttpError(404, 'Debit note not found');
  const [t, lines, party, rel] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(schema.tenants.id, dn.tenantId) }),
    db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, dn.id)).orderBy(supplierInvoiceLines.lineNo),
    dn.partyId ? db.query.parties.findFirst({ where: eq(parties.id, dn.partyId) }) : undefined,
    dn.relatedInvoiceId ? db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, dn.relatedInvoiceId), columns: { invoiceNumber: true, invoiceDate: true } }) : undefined,
  ]);
  const us = companyDetails(t!);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Debit note ${dn.invoiceNumber}`, Author: us.legalName } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const navy = (t?.branding as { primaryColor?: string } | undefined)?.primaryColor ?? '#1f2758', grey = '#555555';

  doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text('DEBIT NOTE', { align: 'right' });
  doc.fontSize(10).font('Helvetica').fillColor(grey).text(`No. ${dn.invoiceNumber}`, { align: 'right' }).text(`Date ${dn.invoiceDate}`, { align: 'right' });
  if (rel) doc.text(`Against invoice ${rel.invoiceNumber} dated ${rel.invoiceDate}`, { align: 'right' });
  doc.moveDown(1);
  const top = doc.y;
  const block = (title: string, rows: (string | null | undefined)[], x: number) => {
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(9).text(title, x, top, { width: 240 });
    const [first, ...rest] = rows.filter(Boolean) as string[];
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10).text(first ?? '', x, doc.y, { width: 240 });
    doc.font('Helvetica').fontSize(9).fillColor(grey);
    for (const r of rest) doc.text(r, { width: 240 });
    return doc.y;
  };
  const y1 = block('FROM', [us.legalName, us.address, us.taxNo ? `GSTIN / tax no. ${us.taxNo}` : null], 48);
  const y2 = block('TO', [party?.legalName ?? party?.name, [party?.address?.line1, party?.address?.city, party?.address?.postalCode].filter(Boolean).join(', ') || null, party?.taxNo ? `GSTIN / tax no. ${party.taxNo}` : null], 310);
  doc.y = Math.max(y1, y2) + 12; doc.x = 48;
  if (dn.description) doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10).text('Reason', { width: 500 }).font('Helvetica').fontSize(10).text(dn.description, { width: 500 }).moveDown(0.6);

  const cols = [48, 330, 390, 470];
  const rowY = doc.y;
  doc.rect(48, rowY - 4, 500, 18).fill(navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  ['Description', 'Qty', 'Rate', 'Amount'].forEach((h, i) => doc.text(h, cols[i] + 4, rowY, { width: i ? 74 : 275, align: i ? 'right' : 'left' }));
  doc.fillColor('#111111').font('Helvetica').fontSize(9);
  let y = rowY + 20;
  for (const l of lines) {
    doc.text(l.description ?? '', cols[0] + 4, y, { width: 275 });
    const h = doc.y - y;
    doc.text(String(Number(l.quantity)), cols[1] + 4, y, { width: 54, align: 'right' }).text(fmt(Number(l.unitPrice)), cols[2] + 4, y, { width: 74, align: 'right' }).text(fmt(Number(l.amount)), cols[3] + 4, y, { width: 74, align: 'right' });
    y += Math.max(h, 12) + 8;
  }
  doc.moveTo(48, y).lineTo(548, y).strokeColor('#dddddd').stroke();
  y += 8;
  const sum = (label: string, v: number, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor('#111111').text(label, 330, y, { width: 140, align: 'right' }).text(`${dn.currency} ${fmt(v)}`, 470, y, { width: 78, align: 'right' }); y += bold ? 18 : 14; };
  sum('Taxable value', Number(dn.subtotal));
  if (Number(dn.taxAmount)) sum('Tax', Number(dn.taxAmount));
  sum('Total', Number(dn.total), true);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(grey).text(amountInWords(Number(dn.total), dn.currency), 48, y + 4, { width: 500 });
  doc.moveDown(2).font('Helvetica').fontSize(9).fillColor(grey).text(`Please adjust this amount against the invoice named above. ${us.signatoryName ? `For ${us.legalName} — ${us.signatoryName}${us.signatoryRole ? `, ${us.signatoryRole}` : ''}` : ''}`, 48, doc.y, { width: 500 });
  doc.end();
  return done;
}
registerAttachment('debitNote', debitNotePdf);

/** Who gets a debit note: the party's accounts email, else its first contact with an email, else its email. */
export async function debitNoteRecipient(t: Tenant, inv: SupplierInvoice) {
  const p = inv.partyId ? await db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.id, inv.partyId)) }) : undefined;
  return p?.ap?.accountsEmail || p?.contacts.find((c) => c.email)?.email || p?.email || null;
}

/** Email an approved debit note with its PDF (setting `debitNoteEmail`: automatically, AP's choice, never). */
export async function emailDebitNote(t: Tenant, inv: SupplierInvoice, by: By) {
  if (inv.kind !== 'DEBIT') throw new HttpError(400, 'Only debit notes are emailed');
  if (invoiceRules(t).debitNoteEmail === 'never') throw new HttpError(400, 'Debit notes aren’t emailed in this workspace (Administration → Invoices).');
  if (!['APPROVED', 'PARTLY_PAID', 'PAID'].includes(inv.status)) throw new HttpError(409, 'Approve the debit note first');
  const to = await debitNoteRecipient(t, inv);
  if (!to) throw new HttpError(400, 'The supplier has no email: add an accounts email on the party first');
  const rel = inv.relatedInvoiceId ? await db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, inv.relatedInvoiceId), columns: { invoiceNumber: true } }) : undefined;
  await sendMail({ tenantId: t.id, to, subject: `Debit note ${inv.invoiceNumber} from ${companyDetails(t).legalName}`,
    body: `Hello,\n\nPlease find attached debit note ${inv.invoiceNumber} for ${inv.currency} ${fmt(Number(inv.total))}${rel ? ` against your invoice ${rel.invoiceNumber}` : ''}.${inv.description ? `\n\nReason: ${inv.description}` : ''}\n\nPlease adjust it in your accounts. Reply to this email with any questions.`,
    attachments: [{ fileName: `${inv.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`, contentType: 'application/pdf', ref: `debitNote:${inv.id}` }] });
  const [row] = await db.update(supplierInvoices).set({ emailedAt: new Date() }).where(eq(supplierInvoices.id, inv.id)).returning();
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.name, action: 'DEBIT_NOTE_EMAILED', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, to }, ip: by.ip });
  return row;
}
