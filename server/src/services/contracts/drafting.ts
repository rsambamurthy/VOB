/**
 * Drafting a contract from a template: pick the template and jurisdiction, choose each clause's wording (standard, a
 * pre-approved fallback, or edited — which makes the draft non-standard), make the Word and PDF, then internal approval.
 *
 * Statuses: DRAFT → (submit) IN_APPROVAL → APPROVED → (mark signed) ACTIVE. Send back / reject → DRAFT.
 * Changing the contract or its wording after a document was made marks the document out of date (draft.version).
 */
import { and, eq } from 'drizzle-orm';
import { AlignmentType, BorderStyle, Document, Footer, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, ContractDraft, ContractTemplate, DraftClause, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { sendMail } from '../../lib/mailer.js';
import { DOCX, removeStored, storeUpload } from '../../integrations/storage/index.js';
import { toPdf } from '../../integrations/office/index.js';
import { cancelFlow, flowView, registerFlowSubject, startFlow } from '../approvalFlow.js';
import { contractApprovalLevels, contractRuleContext, defaultJurisdiction, JURISDICTIONS, optionOn } from './config.js';
import { fieldLabel, fieldValues, fill, fieldsIn, unknownFields } from './fields.js';
import { getTemplate, templateBytes, templatesFor } from './templates.js';
import { getParty } from './parties.js';

const { contracts: C, contractClauses: CL, contractFiles: F } = schema;
type By = { id?: string; name: string; ip?: string };

async function getContract(tenantId: string, id: string) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  return c;
}
const draftAudit = (t: Tenant, c: Contract, by: By, action: string, extra: Record<string, unknown> = {}) =>
  audit({ tenantId: t.id, actor: by.name, action, detail: { subjectId: c.id, number: c.number, ...extra }, ip: by.ip });
function assertDraftable(t: Tenant, c: Contract) {
  if (!optionOn(t, 'templates') && !optionOn(t, 'wordTemplates')) throw new HttpError(409, 'Templates are switched off in Administration → Contracts.');
  if (c.status !== 'DRAFT') throw new HttpError(409, c.status === 'IN_APPROVAL' ? 'The contract is waiting for approval. Withdraw it to make changes.' : 'Only a draft contract’s wording can change.');
}

/** The library clause for a group in a jurisdiction (or for all countries); null when the group doesn't apply there. */
async function clauseFor(tenantId: string, group: string, jurisdiction: string) {
  const rows = await db.select().from(CL).where(and(eq(CL.tenantId, tenantId), eq(CL.group, group), eq(CL.status, 'ACTIVE')));
  return rows.find((r) => r.jurisdiction === jurisdiction) ?? rows.find((r) => r.jurisdiction === 'ALL') ?? null;
}

/* ---------------- start and edit ---------------- */

export async function startDraft(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  assertDraftable(t, c);
  const input = z.object({ templateId: z.string().min(1, 'Choose a template'), jurisdiction: z.enum(Object.keys(JURISDICTIONS) as [string, ...string[]]).optional() }).parse(raw);
  if (!(await templatesFor(t, c)).some((x) => x.id === input.templateId)) throw new HttpError(400, 'That template isn’t for this kind of contract.');
  const tpl = await getTemplate(t, input.templateId);
  const jurisdiction = input.jurisdiction ?? defaultJurisdiction(t);
  const clauses: DraftClause[] = [];
  for (const s of tpl.sections) {
    const cl = await clauseFor(t.id, s.group, jurisdiction);
    if (cl) clauses.push({ clauseId: cl.id, group: cl.group, title: cl.title, variant: 'standard', body: cl.body, required: s.required });
  }
  const draft: ContractDraft = { clauses, nonStandard: false, fallback: false, version: (c.draft?.version ?? 0) + 1, savedAt: new Date().toISOString(), savedBy: by.name };
  const [row] = await db.update(C).set({ templateId: tpl.id, jurisdiction, draft, source: c.source === 'MANUAL' ? 'TEMPLATE' : c.source }).where(eq(C.id, c.id)).returning();
  await draftAudit(t, c, by, 'CONTRACT_DRAFT_STARTED', { template: tpl.name, jurisdiction });
  return row;
}

const draftInput = z.object({
  clauses: z.array(z.object({ group: z.string().min(1), variant: z.string().min(1).default('standard'), body: z.string().max(20_000).optional() })).max(80),
});
/**
 * Save the clause choices. Standard and fallback wording always comes from the library (never trusted from the
 * browser); 'custom' takes the edited text. Optional clauses may be left out; clauses added from the library or
 * edited wording make the draft non-standard, a fallback sets `fallback` — both feed the approval rules.
 */
export async function saveDraft(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  assertDraftable(t, c);
  if (!c.draft || !c.templateId) throw new HttpError(409, 'Start the draft from a template first.');
  const input = draftInput.parse(raw);
  const tpl = await getTemplate(t, c.templateId);
  const inTemplate = new Map(tpl.sections.map((s) => [s.group, s.required]));
  const jurisdiction = c.jurisdiction ?? defaultJurisdiction(t);
  for (const s of c.draft.clauses.filter((x) => x.required)) if (!input.clauses.some((x) => x.group === s.group)) throw new HttpError(400, `“${s.title}” is required by the template and can’t be left out.`);
  if (new Set(input.clauses.map((x) => x.group)).size !== input.clauses.length) throw new HttpError(400, 'A clause is in the draft twice.');
  const clauses: DraftClause[] = []; let nonStandard = false, fallback = false;
  for (const x of input.clauses) {
    const cl = await clauseFor(t.id, x.group, jurisdiction);
    if (!cl) throw new HttpError(400, `There is no “${x.group}” clause for ${JURISDICTIONS[jurisdiction as keyof typeof JURISDICTIONS] ?? jurisdiction} in the library.`);
    let body = cl.body;
    if (x.variant === 'custom') {
      body = (x.body ?? '').trim();
      if (body.length < 10) throw new HttpError(400, `Write the wording for “${cl.title}”.`);
      const bad = unknownFields(fieldsIn(body));
      if (bad.length) throw new HttpError(400, `“${cl.title}” uses ${bad.map((b) => `{{${b}}}`).join(', ')}, which ${bad.length === 1 ? 'isn’t a merge field' : 'aren’t merge fields'}.`);
      if (body !== cl.body) nonStandard = true;
    } else if (x.variant !== 'standard') {
      const fb = cl.fallbacks.find((f) => f.key === x.variant);
      if (!fb) throw new HttpError(400, `“${cl.title}” has no fallback called ${x.variant}.`);
      body = fb.body; fallback = true;
    }
    if (!inTemplate.has(cl.group)) nonStandard = true;
    clauses.push({ clauseId: cl.id, group: cl.group, title: cl.title, variant: body === cl.body ? 'standard' : x.variant, body, required: inTemplate.get(cl.group) ?? false });
  }
  const draft: ContractDraft = { ...c.draft, clauses, nonStandard, fallback, version: c.draft.version + 1, savedAt: new Date().toISOString(), savedBy: by.name };
  const [row] = await db.update(C).set({ draft }).where(eq(C.id, c.id)).returning();
  await draftAudit(t, c, by, 'CONTRACT_DRAFT_SAVED', { nonStandard, fallback, edited: clauses.filter((x) => x.variant === 'custom').map((x) => x.title), fallbacks: clauses.filter((x) => x.variant !== 'standard' && x.variant !== 'custom').map((x) => x.title) });
  return row;
}

/** Changing the contract's own details after a document was made: the document is now out of date. */
export const touchDraft = (c: Contract) => (c.draft ? { ...c.draft, version: c.draft.version + 1 } : null);

/* ---------------- the document ---------------- */

const para = (text: string, opts: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; before?: number } = {}) =>
  new Paragraph({ alignment: opts.align ?? AlignmentType.JUSTIFIED, spacing: { after: opts.after ?? 120, before: opts.before ?? 0 }, children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? 22, font: 'Calibri' })] });
const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

/** A document from a clause-library template: heading, opening paragraph, numbered clauses and signature blocks. */
async function clausesDocx(tpl: ContractTemplate, c: Contract, clauses: DraftClause[], v: Record<string, string>, missing: Set<string>) {
  const f = (s: string) => fill(s, v, missing);
  const body: (Paragraph | Table)[] = [
    para(f(tpl.heading || '{{contract.type}}').toUpperCase(), { bold: true, size: 30, align: AlignmentType.CENTER, after: 80 }),
    para(`${c.number}${c.title ? ` — ${c.title}` : ''}`, { align: AlignmentType.CENTER, size: 20, after: 320 }),
  ];
  if (tpl.preamble) for (const line of f(tpl.preamble).split('\n')) body.push(para(line));
  body.push(para('The Parties agree as follows:', { before: 120, after: 200 }));
  clauses.forEach((cl, i) => {
    body.push(para(`${i + 1}. ${cl.title}`, { bold: true, before: 200, after: 80, align: AlignmentType.LEFT }));
    for (const line of f(cl.body).split('\n').filter((l) => l.trim())) body.push(para(line));
  });
  const cell = (lines: string[]) => new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
    children: lines.map((l, i) => para(l, { bold: i === 0, align: AlignmentType.LEFT, after: i === 0 ? 480 : 80 })) });
  const block = (who: string, name: string, role: string) => [`For and on behalf of ${who}`, 'Signature: ______________________', `Name: ${name || '______________________'}`, `Title: ${role || '______________________'}`, 'Date: ______________________'];
  body.push(para('Signed by the Parties’ authorised representatives:', { before: 360, after: 200 }));
  body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
    cell(block(f('{{us.legalName}}'), v['us.signatoryName'], v['us.signatoryRole'])), cell(block(f('{{party.legalName}}'), v['party.signatoryName'], v['party.signatoryRole'])),
  ] })] }));
  const doc = new Document({
    creator: 'VendorGate', title: `${c.number} ${c.title}`,
    sections: [{ properties: { page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${c.number} · Page `, size: 16, font: 'Calibri' }), new TextRun({ children: [PageNumber.CURRENT], size: 16, font: 'Calibri' }), new TextRun({ text: ' of ', size: 16, font: 'Calibri' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, font: 'Calibri' })] })] }) },
      children: body }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** The workspace's own Word file with its merge fields filled; {{#clauses}}{{number}}. {{title}} {{body}}{{/clauses}} prints the clauses. */
async function wordDocx(t: Tenant, tpl: ContractTemplate, clauses: DraftClause[], v: Record<string, string>, missing: Set<string>) {
  const zip = new PizZip(await templateBytes(t, tpl));
  const data = { clauses: clauses.map((cl, i) => ({ number: String(i + 1), title: cl.title, body: fill(cl.body, v, missing) })) };
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true,
    parser: (tag: string) => ({ get: (scope: Record<string, unknown>) => (tag === '.' ? scope : tag in scope ? scope[tag] : v[tag] ? v[tag] : (missing.add(tag), `[${fieldLabel(tag)}]`)) }),
    nullGetter: () => '',
  });
  doc.render(data);
  return Buffer.from(doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/** Make the Word and PDF of the current draft; they replace the previous generated drafts. */
export async function generateDocument(t: Tenant, id: string, by: By) {
  const c = await getContract(t.id, id);
  assertDraftable(t, c);
  if (!c.draft || !c.templateId) throw new HttpError(409, 'Start the draft from a template first.');
  const tpl = await getTemplate(t, c.templateId);
  const party = await getParty(t.id, c.partyId);
  const v = fieldValues(t, c, party);
  const missing = new Set<string>();
  const docx = tpl.kind === 'WORD' ? await wordDocx(t, tpl, c.draft.clauses, v, missing) : await clausesDocx(tpl, c, c.draft.clauses, v, missing);
  const pdf = await toPdf(docx);
  const version = c.draft.version;
  const base = `${c.number} v${version}`;
  const old = await db.select().from(F).where(and(eq(F.contractId, c.id), eq(F.generated, true)));
  const files = [];
  for (const [buf, ext] of [[docx, 'docx'], [pdf, 'pdf']] as const) {
    if (!buf) continue;
    const stored = await storeUpload(t.id, `contracts/${c.id}`, { buffer: buf, originalname: `${base}.${ext}` }, { types: [DOCX, 'application/pdf'] });
    const [row] = await db.insert(F).values({ tenantId: t.id, contractId: c.id, kind: 'DRAFT', ...stored, uploadedByName: by.name, generated: true, version }).returning();
    files.push(row);
  }
  for (const o of old) { await db.delete(F).where(eq(F.id, o.id)); await removeStored(o).catch(() => {}); }
  await db.update(C).set({ draft: { ...c.draft, generatedVersion: version } }).where(eq(C.id, c.id));
  await draftAudit(t, c, by, 'CONTRACT_DOCUMENT_MADE', { version, pdf: !!pdf, missing: [...missing] });
  return { files: files.map((f) => ({ id: f.id, fileName: f.fileName })), pdf: !!pdf, missing: [...missing].map((k) => ({ key: k, label: fieldLabel(k) })) };
}

/* ---------------- internal approval ---------------- */

const contractLink = (id: string) => `${env.appBaseUrl}/staff/contracts/${id}`;
async function tellOwner(c: Contract, subject: string, body: string) {
  const to = c.ownerId ?? c.createdById;
  if (!to) return;
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, to) });
  if (u?.status === 'ACTIVE') await sendMail({ tenantId: c.tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: contractLink(c.id) });
}

export async function submitForApproval(t: Tenant, id: string, by: By) {
  const c = await getContract(t.id, id);
  if (!optionOn(t, 'internalApproval')) throw new HttpError(409, 'Internal approval is switched off in Administration → Contracts.');
  if (c.status !== 'DRAFT') throw new HttpError(409, 'Only a draft can be submitted for approval.');
  if (c.draft && c.draft.generatedVersion !== c.draft.version) throw new HttpError(400, 'Make the document first, so approvers see the current wording.');
  if (!c.draft) {
    const [n] = await db.select({ id: F.id }).from(F).where(and(eq(F.contractId, c.id), eq(F.kind, 'DRAFT'))).limit(1);
    if (!n) throw new HttpError(400, 'Draft it from a template, or upload the draft, before submitting it.');
  }
  const [claimed] = await db.update(C).set({ status: 'IN_APPROVAL' }).where(and(eq(C.id, c.id), eq(C.status, 'DRAFT'))).returning();
  if (!claimed) throw new HttpError(409, 'The contract was just changed by someone else — refresh the page');
  await draftAudit(t, c, by, 'CONTRACT_SUBMITTED');
  try {
    const { steps } = await startFlow(t, 'contract', c.id, contractApprovalLevels(t), contractRuleContext(c, { nonStandard: !!c.draft?.nonStandard, fallback: !!c.draft?.fallback }), by);
    if (!steps.length) {
      await db.update(C).set({ status: 'APPROVED' }).where(eq(C.id, c.id));
      await draftAudit(t, c, { name: 'System' }, 'CONTRACT_APPROVED', { note: 'No approval level applies' });
      return { status: 'APPROVED' as const, levels: [] as string[] };
    }
    return { status: 'IN_APPROVAL' as const, levels: steps.map((s) => s.label) };
  } catch (err) {
    await db.update(C).set({ status: 'DRAFT' }).where(eq(C.id, c.id));
    throw err;
  }
}

/** Back to draft: withdraw from approval, or reopen an approved contract for changes (approval must then be repeated). */
export async function reopenDraft(t: Tenant, id: string, by: By) {
  const c = await getContract(t.id, id);
  if (c.status !== 'IN_APPROVAL' && c.status !== 'APPROVED') throw new HttpError(409, 'Only a contract in approval or approved can go back to draft.');
  if (c.status === 'IN_APPROVAL') await cancelFlow(t.id, 'contract', c.id);
  const [row] = await db.update(C).set({ status: 'DRAFT' }).where(eq(C.id, c.id)).returning();
  await draftAudit(t, c, by, c.status === 'IN_APPROVAL' ? 'CONTRACT_WITHDRAWN' : 'CONTRACT_REOPENED');
  return row;
}

registerFlowSubject('contract', {
  async describe(tenantId, id) {
    const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
    return c ? { title: c.title, ref: c.number, link: contractLink(c.id), kind: 'Contract' } : null;
  },
  async approved(tenantId, id) {
    const [c] = await db.update(C).set({ status: 'APPROVED' }).where(and(eq(C.tenantId, tenantId), eq(C.id, id), eq(C.status, 'IN_APPROVAL'))).returning();
    if (c) await tellOwner(c, `Approved: ${c.number} ${c.title}`, `${c.number} “${c.title}” is approved. It can now go to ${c.direction === 'SELL' ? 'the customer' : 'the supplier'} for signature.`);
  },
  async returned(tenantId, id, decision, remarks) {
    const [c] = await db.update(C).set({ status: 'DRAFT' }).where(and(eq(C.tenantId, tenantId), eq(C.id, id))).returning();
    if (c) await tellOwner(c, `${decision === 'SEND_BACK' ? 'Sent back' : 'Rejected'}: ${c.number} ${c.title}`,
      decision === 'SEND_BACK' ? `${c.number} “${c.title}” was sent back for changes:\n\n${remarks}\n\nMake the changes and submit it again.` : `${c.number} “${c.title}” was rejected:\n\n${remarks}`);
  },
  async blockedFor(tenantId, id, userId) {
    const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
    return c && (c.ownerId === userId || c.createdById === userId) ? 'You can’t approve a contract you own or drafted. Another approver has to.' : null;
  },
});

/** Everything the contract page needs about drafting and approval. */
export async function draftView(t: Tenant, c: Contract, userId: string) {
  const library = c.draft ? await db.select().from(CL).where(and(eq(CL.tenantId, t.id), eq(CL.status, 'ACTIVE'))) : [];
  const jurisdiction = c.jurisdiction ?? defaultJurisdiction(t);
  const options = (group: string) => {
    const cl = library.find((r) => r.group === group && r.jurisdiction === jurisdiction) ?? library.find((r) => r.group === group && r.jurisdiction === 'ALL');
    return cl ? { standard: cl.body, fallbacks: cl.fallbacks, guidance: cl.guidance } : null;
  };
  const template = c.templateId ? await db.query.contractTemplates.findFirst({ where: eq(schema.contractTemplates.id, c.templateId) }) : null;
  return {
    templates: c.status === 'DRAFT' ? (await templatesFor(t, c)).map((x) => ({ id: x.id, name: x.name, kind: x.kind })) : [],
    template: template ? { id: template.id, name: template.name, kind: template.kind } : null,
    jurisdiction: c.jurisdiction, jurisdictions: JURISDICTIONS, defaultJurisdiction: defaultJurisdiction(t),
    draft: c.draft ? { ...c.draft, upToDate: c.draft.generatedVersion === c.draft.version, clauses: c.draft.clauses.map((x) => ({ ...x, options: options(x.group) })) } : null,
    addable: c.draft ? [...new Map(library.filter((r) => (r.jurisdiction === jurisdiction || r.jurisdiction === 'ALL') && !c.draft!.clauses.some((x) => x.group === r.group)).map((r) => [r.group, { group: r.group, title: r.title, category: r.category }])).values()] : [],
    approvalOn: optionOn(t, 'internalApproval'),
    approval: await flowView(t.id, 'contract', c.id, userId),
  };
}
