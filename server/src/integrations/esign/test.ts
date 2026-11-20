/**
 * Built-in Test signing — the whole flow without an outside provider: each signer clicks "Sign" in VendorGate and
 * a signature certificate page is added to the PDF (who, email, when, the PDF's SHA-256). Marked TEST everywhere; it
 * is not a legal electronic signature. Used for demos, training and automated tests.
 */
import crypto from 'node:crypto';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { LinkProvider } from './types.js';

export async function certificatePage(pdf: Buffer, line: { name: string; email: string; method: string; at: Date }, title = 'TEST SIGNATURE — not a legal signature') {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 780, size: 14, font: bold, color: rgb(0.6, 0.1, 0.1) });
  const rows: [string, string][] = [['Signed by', line.name], ['Email', line.email], ['Method', line.method], ['Signed at (UTC)', line.at.toISOString().replace('T', ' ').slice(0, 19)], ['Document SHA-256', hash.slice(0, 32)], ['', hash.slice(32)]];
  rows.forEach(([k, v], i) => { page.drawText(k, { x: 50, y: 740 - i * 22, size: 10, font: bold }); page.drawText(v, { x: 170, y: 740 - i * 22, size: 10, font }); });
  return Buffer.from(await doc.save());
}

export const testProvider: LinkProvider = {
  key: 'test', label: 'Test signing (built in)', kind: 'link', methods: ['Test click-to-sign'],
  help: 'For trying the flow: each signer clicks Sign in VendorGate and a certificate page is added. Not a legal signature — switch to a real provider before going live.',
  fields: [],
  async check() { return 'Test signing is ready'; },
  async start(_c, a) { return { processId: `test_${crypto.randomUUID()}`, url: a.callbackUrl }; },
  async finish(_c, a) { return certificatePage(a.pdf, { name: a.signer.name, email: a.signer.email, method: 'Test click-to-sign', at: new Date() }); },
};
