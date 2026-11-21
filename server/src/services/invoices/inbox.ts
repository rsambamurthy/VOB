/**
 * Email inbox (Invoices add-on): invoices emailed in become drafts.
 *   - Address: invoices-<workspace>-<token>@INBOUND_EMAIL_DOMAIN — the mail provider posts each message to
 *     /api/inbound/email/<INBOUND_EMAIL_SECRET> (raw MIME, SendGrid / Mailgun multipart, Postmark JSON). Customers usually forward
 *     their own ap-invoices@ address to it.
 *   - Or a mailbox VendorGate reads over IMAP every 5 minutes (job invoices.inbox) — the on-premises way, no inbound domain needed.
 * Every message is recorded once (invoice_mails, by Message-ID); each PDF becomes a draft through draftFromFile (shared with bulk
 * upload), so the same checks — duplicates included — run on arrival. How senders are matched and what is read is the
 * configurable algorithm INBOX below.
 */
import crypto from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { env } from '../../lib/env.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { defineAlgorithm } from '../../lib/algorithms.js';
import { defineJob } from '../../jobs/queue.js';
import { storeUpload } from '../../integrations/storage/index.js';
import { unpack } from '../contracts/migration.js';
import { textOf } from '../contracts/reading.js';
import { invoicesLicensed, invoicesOn, optionOn } from './config.js';
import { draftFromFile, poFinder, sameFile } from './capture.js';
import { readInvoiceText } from './reading.js';
import { panOf } from './duplicates.js';

const { invoiceMails, parties, tenants } = schema;

export const INBOX = defineAlgorithm({
  key: 'invoiceInbox', name: 'Email inbox: matching and reading', module: 'Invoices',
  summary: 'How an emailed invoice is turned into a draft: which attachments count, how the supplier and purchase order are found, and what is read from the PDF.',
  runs: 'For every email that reaches the workspace’s invoices address or the mailbox VendorGate reads.',
  steps: [
    { title: 'Record the email once', text: 'By its Message-ID — the same email forwarded or fetched again is not processed twice.' },
    { title: 'Pick the attachments', text: 'PDFs, and PDFs inside a .zip; scanned images (PNG / JPG) when allowed and above the minimum size, so logos and signatures are skipped. At most the set number per email.' },
    { title: 'Find the supplier', text: 'The sender’s address against each supplier’s email, accounts email and contacts; then, if allowed, the sender’s domain when exactly one supplier uses it (free-mail domains never count); then a GSTIN printed on the invoice; then the purchase order’s supplier.' },
    { title: 'Find the purchase order', text: 'A PO number (4+ characters) in the file name, the subject, the email text or the PDF text — only when exactly one order matches.' },
    { title: 'Read the PDF', text: 'If allowed: invoice number, invoice date, total, IRN and GSTINs from the PDF’s text (no AI; scans have no text). AP checks them before submitting.' },
    { title: 'Make the draft and check it', text: 'One draft per attachment, with the email linked. All invoice checks run at once — a file already received is not made into a second draft.' },
  ],
  params: [
    { key: 'unknownSenders', label: 'Drafts from unknown senders', help: 'Make drafts (without a supplier) from senders that match no supplier. Off = record the email and make nothing.', type: 'boolean', default: true },
    { key: 'matchDomain', label: 'Match by email domain', help: 'A sender from a supplier’s domain (accounts@kirloskar.com for a supplier with sales@kirloskar.com) counts as that supplier when only one supplier uses the domain.', type: 'boolean', default: true },
    { key: 'readPdf', label: 'Read the PDF', help: 'Fill the number, date, total and IRN from the PDF’s text.', type: 'boolean', default: true },
    { key: 'acceptImages', label: 'Accept scanned images', help: 'PNG and JPG attachments become invoices too.', type: 'boolean', default: true },
    { key: 'minImageKb', label: 'Smallest image', help: 'Images smaller than this are logos or signatures and are skipped.', type: 'number', default: 40, min: 0, max: 5000, unit: 'KB' },
    { key: 'maxAttachments', label: 'Attachments per email', help: 'More than this and only the first are taken (the email is still recorded).', type: 'number', default: 20, min: 1, max: 100 },
  ],
  rules: [],
  notes: ['Nothing is sent back to the sender.', 'Email from a supplier on hold still arrives; the hold shows as a check on the draft.'],
  enabled: (t: Tenant) => invoicesLicensed(t),
});

/* ---------------- settings (address and mailbox) ---------------- */

export interface InboxSettings { token?: string; imap?: { host: string; port: number; secure: boolean; user: string; password: string; folder: string; processedFolder?: string | null } | null }
const stored = (t: Tenant): InboxSettings => ((t.settings.invoices as { inbox?: InboxSettings } | undefined)?.inbox ?? {});
export const inboxAddress = (t: Pick<Tenant, 'slug'>, token?: string) => (env.int.INBOUND_EMAIL_DOMAIN && token ? `invoices-${t.slug}-${token}@${env.int.INBOUND_EMAIL_DOMAIN}` : null);

export function inboxView(t: Tenant) {
  const s = stored(t);
  return {
    on: optionOn(t, 'emailInbox'), address: inboxAddress(t, s.token), addressAvailable: !!env.int.INBOUND_EMAIL_DOMAIN,
    imap: s.imap ? { host: s.imap.host, port: s.imap.port, secure: s.imap.secure, user: s.imap.user, folder: s.imap.folder, processedFolder: s.imap.processedFolder ?? null, passwordSet: !!s.imap.password } : null,
  };
}

const imapInput = z.object({
  host: z.string().trim().min(3).max(200).regex(/^[a-z0-9.\-]+$/i, 'Enter a host name, e.g. imap.gmail.com'), port: z.coerce.number().int().min(1).max(65535).default(993), secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(200), password: z.string().max(500).optional(), folder: z.string().trim().min(1).max(100).default('INBOX'), processedFolder: z.string().trim().max(100).optional().nullable(),
}).strict();
const inboxInput = z.object({ newAddress: z.boolean().optional(), imap: imapInput.nullable().optional() }).strict();

/** Save the address / mailbox. The password is kept encrypted and never returned; empty = keep the saved one. */
export function saveInbox(t: Tenant, raw: unknown) {
  const input = inboxInput.parse(raw ?? {});
  const prev = stored(t);
  const next: InboxSettings = { ...prev };
  if (input.newAddress || !prev.token) next.token = crypto.randomBytes(6).toString('hex').slice(0, 10);
  if (input.imap === null) next.imap = null;
  else if (input.imap) {
    const pw = input.imap.password ? encrypt(input.imap.password) : prev.imap?.password;
    if (!pw) throw new HttpError(400, 'Enter the mailbox password (an app password for Gmail / Microsoft 365)');
    next.imap = { host: input.imap.host, port: input.imap.port, secure: input.imap.secure, user: input.imap.user, password: pw, folder: input.imap.folder, processedFolder: input.imap.processedFolder || null };
  }
  const changes = [input.newAddress ? 'new inbox address' : null, input.imap === null ? 'mailbox removed' : input.imap ? `mailbox ${input.imap.user}@${input.imap.host}` : null].filter(Boolean) as string[];
  return { settings: { ...t.settings, invoices: { ...(t.settings.invoices ?? {}), inbox: next } } as Tenant['settings'], changes };
}

/* ---------------- one message ---------------- */

export interface MailIn {
  messageId?: string | null; from: { address: string; name?: string | null }; to: string[]; subject?: string | null; date?: Date | null; text?: string | null;
  attachments: { fileName: string; contentType?: string | null; content: Buffer; inline?: boolean }[];
}

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'rediffmail.com', 'icloud.com', 'zoho.com', 'protonmail.com', 'aol.com']);
const SYSTEM = { name: 'Email inbox', id: null as string | null };

/** The supplier party a sender belongs to (address, accounts email, contacts; then a domain used by exactly one supplier). */
export async function partyForSender(t: Tenant, address: string, matchDomain: boolean) {
  const a = address.trim().toLowerCase();
  const exact = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.tenantId, t.id), eq(parties.kind, 'SUPPLIER'), eq(parties.status, 'ACTIVE'),
    sql`(lower(${parties.email}) = ${a} or lower(${parties.ap}->>'accountsEmail') = ${a} or exists (select 1 from jsonb_array_elements(${parties.contacts}) c where lower(c->>'email') = ${a}))`)).limit(2);
  if (exact.length === 1) return exact[0].id;
  const domain = a.split('@')[1];
  if (!matchDomain || !domain || FREE_MAIL.has(domain)) return null;
  const like = `%@${domain}`;
  const byDomain = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.tenantId, t.id), eq(parties.kind, 'SUPPLIER'), eq(parties.status, 'ACTIVE'),
    sql`(lower(${parties.email}) like ${like} or lower(${parties.ap}->>'accountsEmail') like ${like} or exists (select 1 from jsonb_array_elements(${parties.contacts}) c where lower(c->>'email') like ${like}))`)).limit(2);
  return byDomain.length === 1 ? byDomain[0].id : null;
}

async function partyForGstins(t: Tenant, gstins: string[]) {
  for (const g of gstins) {
    const pan = panOf(g);
    const rows = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.tenantId, t.id), eq(parties.kind, 'SUPPLIER'), eq(parties.status, 'ACTIVE'),
      sql`(upper(replace(${parties.taxNo}, ' ', '')) = ${g} or (${pan}::text is not null and substr(upper(replace(${parties.taxNo}, ' ', '')), 3, 10) = ${pan}))`)).limit(2);
    if (rows.length === 1) return rows[0].id;
  }
  return null;
}

const isPdf = (a: MailIn['attachments'][number]) => /pdf/i.test(a.contentType ?? '') || /\.pdf$/i.test(a.fileName) || a.content.subarray(0, 5).toString('latin1') === '%PDF-';
const isImage = (a: MailIn['attachments'][number]) => /^image\/(png|jpe?g)$/i.test(a.contentType ?? '') || /\.(png|jpe?g)$/i.test(a.fileName);
const isZip = (a: MailIn['attachments'][number]) => /zip/i.test(a.contentType ?? '') || /\.zip$/i.test(a.fileName);

/** Record a message and make drafts from it. Safe to call twice with the same message. */
export async function ingestMail(t: Tenant, m: MailIn, via: 'WEBHOOK' | 'IMAP') {
  const messageId = (m.messageId || '').trim().slice(0, 300) || `sha:${crypto.createHash('sha256').update(`${m.from.address}|${m.subject}|${m.date?.toISOString()}|${m.attachments.map((a) => crypto.createHash('sha256').update(a.content).digest('hex')).join(',')}`).digest('hex')}`;
  const [mail] = await db.insert(invoiceMails).values({
    tenantId: t.id, messageId, via, fromAddress: m.from.address.slice(0, 300), fromName: m.from.name?.slice(0, 200) ?? null, subject: m.subject?.slice(0, 500) ?? null, toAddress: m.to.join(', ').slice(0, 500),
    receivedAt: m.date ?? new Date(), status: 'RECEIVED', body: m.text?.slice(0, 10000) ?? null,
  }).onConflictDoNothing().returning();
  if (!mail) return db.query.invoiceMails.findFirst({ where: and(eq(invoiceMails.tenantId, t.id), eq(invoiceMails.messageId, messageId)) });
  const finish = async (status: string, reason: string | null, extra: Partial<typeof invoiceMails.$inferInsert> = {}) => {
    const [row] = await db.update(invoiceMails).set({ status, reason, ...extra }).where(eq(invoiceMails.id, mail.id)).returning();
    return row;
  };
  try {
    if (!invoicesOn(t) || !optionOn(t, 'emailInbox')) return finish('IGNORED', 'The email inbox is switched off in Administration → Invoices.');
    const p = INBOX.resolve(t).params;
    // Attachments: PDFs (also inside a .zip), and scanned images if allowed.
    const files: { fileName: string; content: Buffer }[] = [];
    const skipped: { fileName: string; size: number; result: string }[] = [];
    for (const a of m.attachments) {
      if (isZip(a)) { const u = unpack([{ buffer: a.content, originalname: a.fileName }] as never); for (const f of u.files as { buffer: Buffer; originalname: string }[]) files.push({ fileName: f.originalname, content: f.buffer }); continue; }
      if (isPdf(a)) files.push({ fileName: a.fileName, content: a.content });
      else if (p.acceptImages && isImage(a) && !a.inline && a.content.length >= Number(p.minImageKb) * 1024) files.push({ fileName: a.fileName, content: a.content });
      else skipped.push({ fileName: a.fileName, size: a.content.length, result: 'Skipped — not an invoice file' });
    }
    const take = files.slice(0, Number(p.maxAttachments));
    for (const f of files.slice(Number(p.maxAttachments))) skipped.push({ fileName: f.fileName, size: f.content.length, result: `Skipped — more than ${p.maxAttachments} attachments` });
    if (!take.length) return finish('NO_ATTACHMENT', 'No PDF or scanned invoice attached', { attachments: skipped });

    let partyId = await partyForSender(t, m.from.address, !!p.matchDomain);
    const find = await poFinder(t);
    const ownGstin = (t.billing as { gstin?: string } | null)?.gstin ?? null;
    const results: { fileName: string; size: number; result: string; invoiceId?: string }[] = [];
    const ids: string[] = [];
    for (const f of take) {
      let stored;
      try { stored = await storeUpload(t.id, 'invoices', { buffer: f.content, originalname: f.fileName }); }
      catch (e) { results.push({ fileName: f.fileName, size: f.content.length, result: `Not accepted — ${(e as Error).message}` }); continue; }
      const dup = await sameFile(t, stored.sha256);
      if (dup) { results.push({ fileName: f.fileName, size: f.content.length, result: `Already received as ${dup.invoiceNumber}`, invoiceId: dup.id }); continue; }
      const text = p.readPdf && stored.mimeType === 'application/pdf' ? await textOf(f.content, 'application/pdf').catch(() => '') : '';
      const facts = text ? readInvoiceText(text, { gstin: ownGstin }) : null;
      const po = find(f.fileName.replace(/\.[a-z0-9]+$/i, ''), m.subject, m.text, text);
      let fileParty = partyId;
      if (!fileParty && facts?.gstins?.length) fileParty = await partyForGstins(t, facts.gstins);
      if (!fileParty && !po && !p.unknownSenders) { results.push({ fileName: f.fileName, size: f.content.length, result: 'Skipped — sender isn’t a known supplier' }); continue; }
      const row = await draftFromFile(t, stored, { source: 'EMAIL', by: SYSTEM, po, partyId: po?.vendorId ? null : fileParty, guess: f.fileName.replace(/\.[a-z0-9]+$/i, ''), facts, mailId: mail.id });
      partyId = partyId ?? row.partyId;
      ids.push(row.id);
      results.push({ fileName: f.fileName, size: f.content.length, result: 'Draft created', invoiceId: row.id });
    }
    const all = [...results, ...skipped];
    const status = ids.length ? 'PROCESSED' : results.some((r) => r.result.startsWith('Already')) ? 'DUPLICATE' : results.some((r) => r.result.includes('known supplier')) ? 'IGNORED' : 'FAILED';
    const row = await finish(status, ids.length ? null : all.map((r) => `${r.fileName}: ${r.result}`).join('; ').slice(0, 1000), { invoiceIds: ids, attachments: all, partyId });
    if (ids.length) await audit({ tenantId: t.id, actor: 'Email inbox', action: 'INVOICES_EMAILED_IN', detail: { from: m.from.address, subject: m.subject, drafts: ids.length } });
    return row;
  } catch (e) {
    logger.warn({ err: String(e), tenant: t.slug }, 'invoice email failed');
    return finish('FAILED', String((e as Error).message ?? e).slice(0, 500));
  }
}

/* ---------------- arrival: webhook and mailbox ---------------- */

/** The workspace an inbound address belongs to (invoices-<slug>-<token>@domain). */
export async function tenantForAddress(addresses: string[]) {
  for (const raw of addresses) {
    const m = /invoices-([a-z0-9][a-z0-9-]*)-([a-f0-9]{10})@/i.exec(raw);
    if (!m) continue;
    const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, m[1].toLowerCase()) });
    const token = t ? stored(t).token : undefined;
    const given = Buffer.from(m[2].toLowerCase());
    if (t && token && given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token))) return t;
  }
  return null;
}

/** Parse a raw MIME message (mailparser). */
export async function parseMime(raw: Buffer): Promise<MailIn> {
  const { simpleParser } = await import('mailparser');
  const p = await simpleParser(raw, { skipHtmlToText: false });
  const addrs = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []).flatMap((a: { value?: { address?: string }[] }) => (a.value ?? []).map((v) => v.address ?? '')).filter(Boolean);
  return {
    messageId: p.messageId ?? null, from: { address: p.from?.value[0]?.address ?? '', name: p.from?.value[0]?.name ?? null }, to: [...addrs(p.to), ...addrs(p.cc)],
    subject: p.subject ?? null, date: p.date ?? null, text: p.text ?? null,
    attachments: p.attachments.map((a) => ({ fileName: a.filename ?? 'attachment', contentType: a.contentType, content: a.content, inline: a.contentDisposition === 'inline' && !!a.cid })),
  };
}

/**
 * The inbound webhook body, whatever the provider: raw MIME (message/rfc822), multipart with the raw message (SendGrid "send raw",
 * Mailgun `body-mime`) or with fields and files (Mailgun, SendGrid parsed), or JSON (Postmark, or { from, to, subject, attachments: [{ fileName, contentBase64 }] }).
 */
export async function mailFromRequest(body: unknown, files: { fieldname: string; originalname: string; mimetype: string; buffer: Buffer }[] = [], rawBody?: Buffer): Promise<MailIn> {
  if (rawBody?.length) return parseMime(rawBody);
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.email ?? b['body-mime'] ?? b.RawEmail;
  if (typeof raw === 'string' && raw.length) return parseMime(Buffer.from(raw));
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const addr = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim();
  if (b.FromFull || b.MessageID) {
    const full = (b.FromFull ?? {}) as { Email?: string; Name?: string };
    return {
      messageId: str(b.MessageID) || null, from: { address: full.Email ?? addr(str(b.From)), name: full.Name ?? null },
      to: [...((b.ToFull as { Email: string }[] | undefined) ?? []).map((x) => x.Email), ...((b.CcFull as { Email: string }[] | undefined) ?? []).map((x) => x.Email), addr(str(b.OriginalRecipient))].filter(Boolean),
      subject: str(b.Subject) || null, date: b.Date ? new Date(str(b.Date)) : null, text: str(b.TextBody) || null,
      attachments: ((b.Attachments as { Name: string; Content: string; ContentType: string; ContentID?: string }[] | undefined) ?? []).map((a) => ({ fileName: a.Name, contentType: a.ContentType, content: Buffer.from(a.Content, 'base64'), inline: !!a.ContentID })),
    };
  }
  const toList = str(b.to ?? b.recipient ?? b.To).split(',').map(addr).filter(Boolean);
  return {
    messageId: str(b['Message-Id'] ?? b.messageId ?? b['message-id']) || null, from: { address: addr(str(b.from ?? b.sender ?? b.From)) }, to: toList,
    subject: str(b.subject ?? b.Subject) || null, date: null, text: str(b.text ?? b['body-plain'] ?? b['stripped-text']) || null,
    attachments: [
      ...files.map((f) => ({ fileName: f.originalname, contentType: f.mimetype, content: f.buffer })),
      ...((b.attachments as { fileName?: string; filename?: string; contentType?: string; contentBase64?: string }[] | undefined) ?? []).filter((a) => a.contentBase64).map((a) => ({ fileName: a.fileName ?? a.filename ?? 'attachment', contentType: a.contentType ?? null, content: Buffer.from(a.contentBase64!, 'base64') })),
    ],
  };
}

/** Read new messages from a workspace's mailbox (IMAP): unseen ones, oldest first, up to 50 a run; each marked seen (and moved if set). */
export async function pollMailbox(t: Tenant, opts: { test?: boolean } = {}) {
  const s = stored(t).imap;
  if (!s) throw new HttpError(409, 'No mailbox set up');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: decrypt(s.password) }, logger: false, socketTimeout: 30000 });
  let processed = 0, unread = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(s.folder);
    try {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
      unread = uids.length;
      if (opts.test) return { ok: true, message: `Connected to ${s.user}: ${unread} unread message${unread === 1 ? '' : 's'} in ${s.folder}.`, processed: 0 };
      for (const uid of uids.slice(0, 50)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        await ingestMail(t, await parseMime(msg.source), 'IMAP');
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        if (s.processedFolder) await client.messageMove(String(uid), s.processedFolder, { uid: true }).catch(() => {});
        processed++;
      }
    } finally { lock.release(); }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as { responseText?: string; message?: string }).responseText ?? (e as Error).message;
    throw new HttpError(502, `Couldn’t read the mailbox: ${msg}`);
  } finally { await client.logout().catch(() => {}); }
  return { ok: true, message: `${processed} message${processed === 1 ? '' : 's'} read.`, processed, unread };
}

defineJob('invoices.inbox', async () => {
  for (const t of await db.select().from(tenants).where(eq(tenants.status, 'ACTIVE'))) {
    if (!invoicesOn(t) || !optionOn(t, 'emailInbox') || !stored(t).imap) continue;
    await pollMailbox(t).catch((err) => logger.warn({ err: String(err), tenant: t.slug }, 'invoice mailbox read failed'));
  }
}, { retryLimit: 0, expireInSeconds: 280 });

/* ---------------- the inbox screen ---------------- */

export async function listMails(t: Tenant, q: { status?: string; page?: number }) {
  const size = 50, page = Math.max(1, Number(q.page) || 1);
  const rows = await db.select().from(invoiceMails).where(and(eq(invoiceMails.tenantId, t.id), ...(q.status ? [eq(invoiceMails.status, q.status)] : [])))
    .orderBy(desc(invoiceMails.receivedAt)).limit(size + 1).offset((page - 1) * size);
  const partyIds = [...new Set(rows.map((r) => r.partyId).filter(Boolean) as string[])];
  const names = partyIds.length ? await db.select({ id: parties.id, name: parties.name, code: parties.code }).from(parties).where(inArray(parties.id, partyIds)) : [];
  return { rows: rows.slice(0, size).map(({ body: _b, ...r }) => ({ ...r, party: names.find((n) => n.id === r.partyId) ?? null })), hasMore: rows.length > size, page };
}
export async function getMail(t: Tenant, id: string) {
  const m = await db.query.invoiceMails.findFirst({ where: and(eq(invoiceMails.tenantId, t.id), eq(invoiceMails.id, id)) });
  if (!m) throw new HttpError(404, 'Email not found');
  return m;
}
