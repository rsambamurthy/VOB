/**
 * Signing a contract through the workspace's e-signature provider (integrations/esign).
 *   email providers: send the PDF → follow the status (webhook + the contracts.esign job) → download the signed PDF.
 *   link providers:  each signer, in order, presses Sign in VendorGate (staff page, review portal or supplier portal);
 *                    their browser goes to the provider and comes back to /api/esign/return/… with a one-time code.
 * When everyone has signed: the signed PDF is stored as the contract's signed copy and the contract becomes active.
 */
import crypto from 'node:crypto';
import { and, eq, inArray, lt, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, ContractSignature, SignatureSigner, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { defineJob } from '../../jobs/queue.js';
import { mailSupplier } from '../../i18n/emails.js';
import { defaultSupplierLanguage } from '../../i18n/index.js';
import { readBytes, storeUpload } from '../../integrations/storage/index.js';
import { cfgOf, providerOf, type ESignSettings, type ESignProvider } from '../../integrations/esign/index.js';
import { optionOn } from './config.js';
import { currentDraftFiles, issueLink, revokeReviewers, tellOwner } from './negotiation.js';
import { getParty } from './parties.js';

const { contracts: C, contractSignatures: S, contractFiles: F } = schema;
type By = { id?: string; name: string; email?: string; ip?: string };
const today = () => new Date().toISOString().slice(0, 10);

export const esignSettings = (t: Tenant): ESignSettings => ((t.settings.contracts as { esign?: ESignSettings } | undefined)?.esign ?? {});
/** The provider in use, when e-signature is switched on and set up. */
export function activeProvider(t: Tenant): { provider: ESignProvider; cfg: ReturnType<typeof cfgOf> } | null {
  if (!optionOn(t, 'esign')) return null;
  const s = esignSettings(t);
  const provider = s.provider ? providerOf(s.provider) : null;
  return provider ? { provider, cfg: cfgOf(s) } : null;
}
const sigAudit = (t: Pick<Tenant, 'id'>, c: Pick<Contract, 'id' | 'number'>, actor: string, action: string, extra: Record<string, unknown> = {}, ip?: string) =>
  audit({ tenantId: t.id, actor, action, detail: { subjectId: c.id, number: c.number, ...extra }, ip });
async function getContract(tenantId: string, id: string) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  return c;
}
const openSignature = (contractId: string) => db.query.contractSignatures.findFirst({ where: and(eq(S.contractId, contractId), eq(S.status, 'SENT')) });
const providerFor = (sig: ContractSignature, t: Tenant) => {
  const p = providerOf(sig.provider);
  if (!p) throw new HttpError(409, 'This signature provider isn’t available any more.');
  return { p, cfg: cfgOf(esignSettings(t)) };
};

/* ---------------- sending ---------------- */

const sendInput = z.object({
  signers: z.array(z.object({ name: z.string().trim().min(2, 'Give each signer’s name').max(120), email: z.string().trim().toLowerCase().email('Use a valid email address'), side: z.enum(['US', 'PARTY']) })).min(2, 'Add a signer for each side').max(10),
  message: z.string().trim().max(2000).optional(),
});
export async function sendForSignature(t: Tenant, id: string, raw: unknown, by: By) {
  const active = activeProvider(t);
  if (!active) throw new HttpError(409, 'E-signature isn’t set up. An administrator chooses the provider in Administration → Contracts.');
  const c = await getContract(t.id, id);
  const ok = c.status === 'AGREED' || c.status === 'APPROVED' || (c.status === 'DRAFT' && !optionOn(t, 'internalApproval') && !c.draft);
  if (!ok) throw new HttpError(409, c.status === 'WITH_PARTY' ? 'The other party hasn’t accepted this version yet.' : c.status === 'SIGNING' ? 'It is already out for signature.' : 'The contract needs to be approved (and accepted by the other party, if you sent it for review) first.');
  const input = sendInput.parse(raw);
  if (!input.signers.some((s) => s.side === 'PARTY') || !input.signers.some((s) => s.side === 'US')) throw new HttpError(400, 'Add at least one signer for each side.');
  if (new Set(input.signers.map((s) => s.email)).size !== input.signers.length) throw new HttpError(400, 'Each signer needs their own email address.');
  const pdfFile = (await currentDraftFiles(c)).find((f) => f.mimeType === 'application/pdf');
  if (!pdfFile) throw new HttpError(400, 'A PDF of the contract is needed: make the document, or upload the final draft as a PDF.');
  const pdf = await readBytes(pdfFile);
  // The other party signs first, then us.
  const ordered = [...input.signers.filter((s) => s.side === 'PARTY'), ...input.signers.filter((s) => s.side === 'US')];
  const signers: SignatureSigner[] = ordered.map((s, i) => ({ ...s, order: i + 1, status: 'WAITING' }));
  const { provider, cfg } = active;
  const [sig] = await db.insert(S).values({ tenantId: t.id, contractId: c.id, provider: provider.key, signers, documentFileId: pdfFile.id, previousStatus: c.status, sentByName: by.name }).returning();
  try {
    if (provider.kind === 'email') {
      const r = await provider.send(cfg, { title: `${c.number} ${c.title}`, message: input.message || `Please sign ${c.number} “${c.title}”.`, pdf, fileName: `${c.number}.pdf`, reference: c.number,
        signers: signers.map(({ name, email, side, order }) => ({ name, email, side, order })), callbackUrl: `${env.appBaseUrl}/api/esign/webhook/${t.id}/${provider.key}` });
      await db.update(S).set({ externalId: r.externalId, signers: signers.map((s) => ({ ...s, status: 'SENT' as const })) }).where(eq(S.id, sig.id));
    } else {
      await db.update(S).set({ signers: signers.map((s, i) => ({ ...s, status: i === 0 ? 'SENT' as const : 'WAITING' as const })) }).where(eq(S.id, sig.id));
      await tellSigner(t, c, signers[0]);
    }
  } catch (e) {
    await db.update(S).set({ status: 'FAILED', error: (e as Error).message.slice(0, 500) }).where(eq(S.id, sig.id));
    throw new HttpError(502, `The signature request couldn’t be sent — ${(e as Error).message}`);
  }
  const [row] = await db.update(C).set({ status: 'SIGNING' }).where(eq(C.id, c.id)).returning();
  await sigAudit(t, c, by.name, 'CONTRACT_SENT_FOR_SIGNATURE', { provider: provider.label, signers: signers.map((s) => s.email) }, by.ip);
  return row;
}

/** Link providers: tell the next signer it's their turn (the other party by email link, us by the staff page). */
async function tellSigner(t: Tenant, c: Contract, s: SignatureSigner) {
  if (s.side === 'PARTY') {
    const link = await issueLink(t, c, s);
    await mailSupplier(defaultSupplierLanguage(t), { tenantId: t.id, to: s.email, link }, 'contractSign', { first: s.name.split(' ')[0], buyer: t.name, title: c.title, number: c.number });
  } else {
    await sendMail({ tenantId: t.id, to: s.email, subject: `Please sign ${c.number} ${c.title}`, body: `Hello ${s.name},\n\n${c.number} “${c.title}” is ready for your signature. Open it and choose Sign.`, link: `${env.appBaseUrl}/staff/contracts/${c.id}` });
  }
}

/* ---------------- link providers: one signer at a time ---------------- */

/** The PDF signed so far (the signed-so-far file, or the document sent). */
async function pdfSoFar(sig: ContractSignature) {
  const f = await db.query.contractFiles.findFirst({ where: eq(F.id, sig.signedFileId ?? sig.documentFileId) });
  if (!f) throw new HttpError(409, 'The document to sign is missing.');
  return readBytes(f);
}
/** Whose turn it is (link providers). */
const turnOf = (sig: ContractSignature) => sig.signers.findIndex((s) => s.status === 'SENT');

/** Start signing for the signer whose turn it is; `email` must be theirs. Answers the URL to send the browser to. */
export async function startSigning(t: Tenant, contractId: string, email: string, returnTo: string) {
  const sig = await openSignature(contractId);
  if (!sig) throw new HttpError(409, 'There is nothing to sign.');
  const { p, cfg } = providerFor(sig, t);
  if (p.kind !== 'link') throw new HttpError(409, 'Signers sign from the email the provider sent them.');
  const i = turnOf(sig);
  const s = sig.signers[i];
  if (!s || s.email !== email.trim().toLowerCase()) throw new HttpError(403, i >= 0 ? `It’s ${sig.signers[i].name}’s turn to sign.` : 'There is nothing for you to sign.');
  const c = await getContract(t.id, contractId);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const callbackUrl = `${env.appBaseUrl}/api/esign/return/${sig.id}/${nonce}`;
  const started = await p.start(cfg, { pdf: await pdfSoFar(sig), fileName: `${c.number}.pdf`, signer: s, callbackUrl, reference: c.number });
  const signers = sig.signers.map((x, j) => (j === i ? { ...x, nonce, processId: started.processId, processState: started.state, returnTo } : x));
  await db.update(S).set({ signers }).where(eq(S.id, sig.id));
  return started.url;
}

/** The browser comes back from the provider: add the signature, pass to the next signer or finish. Answers where to go. */
export async function finishSigning(sigId: string, nonce: string, query: Record<string, string>) {
  const sig = await db.query.contractSignatures.findFirst({ where: and(eq(S.id, sigId), eq(S.status, 'SENT')) });
  const i = sig ? sig.signers.findIndex((s) => s.nonce && s.nonce.length === nonce.length && crypto.timingSafeEqual(Buffer.from(s.nonce), Buffer.from(nonce))) : -1;
  if (!sig || i < 0) throw new HttpError(404, 'This signing link has already been used.');
  const s = sig.signers[i];
  const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, sig.tenantId) }))!;
  const c = await getContract(t.id, sig.contractId);
  const { p, cfg } = providerFor(sig, t);
  if (p.kind !== 'link') throw new HttpError(409, 'Wrong provider.');
  const clean = sig.signers.map((x, j) => (j === i ? { ...x, nonce: undefined } : x));
  let signed: Buffer;
  try { signed = await p.finish(cfg, { processId: s.processId!, state: s.processState, pdf: await pdfSoFar(sig), signer: s, query }); }
  catch (e) {
    await db.update(S).set({ signers: clean, error: (e as Error).message.slice(0, 500) }).where(eq(S.id, sig.id));
    logger.warn({ err: e, sig: sig.id }, 'signing did not finish');
    return `${s.returnTo ?? '/'}${(s.returnTo ?? '').includes('?') ? '&' : '?'}signing=failed`;
  }
  const stored = await storeUpload(t.id, `contracts/${c.id}`, { buffer: signed, originalname: `${c.number} signed.pdf` }, { types: ['application/pdf'] });
  const [file] = await db.insert(F).values({ tenantId: t.id, contractId: c.id, kind: 'SIGNING', ...stored, uploadedByName: s.name }).returning();
  if (sig.signedFileId) await db.delete(F).where(eq(F.id, sig.signedFileId));
  const signers = clean.map((x, j) => (j === i ? { ...x, status: 'SIGNED' as const, signedAt: new Date().toISOString(), method: p.methods[0] } : j === i + 1 ? { ...x, status: 'SENT' as const } : x));
  await db.update(S).set({ signers, signedFileId: file.id, error: null }).where(eq(S.id, sig.id));
  await sigAudit(t, c, s.email, 'CONTRACT_SIGNED_BY', { name: s.name, side: s.side, method: p.methods[0] });
  const next = signers[i + 1];
  if (next) await tellSigner(t, c, next);
  else await complete(t, { ...sig, signers, signedFileId: file.id }, signed);
  return `${s.returnTo ?? '/'}${(s.returnTo ?? '').includes('?') ? '&' : '?'}signing=done`;
}

/* ---------------- following email providers ---------------- */

/** Ask the provider how it's going; on completion download the signed PDF. */
export async function refreshSignature(sig: ContractSignature) {
  if (sig.status !== 'SENT' || !sig.externalId) return sig;
  const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, sig.tenantId) }))!;
  const { p, cfg } = providerFor(sig, t);
  if (p.kind !== 'email') return sig;
  const st = await p.status(cfg, sig.externalId);
  const signers = sig.signers.map((s) => { const x = st.signers.find((y) => y.email.toLowerCase() === s.email); return x ? { ...s, status: x.status, signedAt: x.signedAt ?? s.signedAt } : s; });
  await db.update(S).set({ signers, lastCheckedAt: new Date() }).where(eq(S.id, sig.id));
  if (st.state === 'COMPLETED') await complete(t, { ...sig, signers }, await p.download(cfg, sig.externalId));
  else if (st.state !== 'SENT') await stopped(t, { ...sig, signers }, st.state);
  return (await db.query.contractSignatures.findFirst({ where: eq(S.id, sig.id) }))!;
}
export async function refreshFor(t: Tenant, contractId: string) {
  const sig = await openSignature(contractId);
  if (!sig) throw new HttpError(409, 'There is no signature request out.');
  try { await refreshSignature(sig); } catch (e) { throw new HttpError(502, `The provider couldn’t be asked — ${(e as Error).message}`); }
}

/** Webhook: identify the request (the provider checks its own signature header where it has one) and refresh it. */
export async function handleWebhook(tenantId: string, providerKey: string, headers: Record<string, string | string[] | undefined>, raw: Buffer) {
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) });
  const p = providerOf(providerKey);
  if (!t || !p || p.kind !== 'email') return { ok: false, headers: {} };
  const answer = p.webhookAnswer?.(headers) ?? {};
  const hit = p.webhook(cfgOf(esignSettings(t)), headers, raw);
  if (!hit) return { ok: true, headers: answer };
  const sig = await db.query.contractSignatures.findFirst({ where: and(eq(S.tenantId, t.id), eq(S.provider, p.key), eq(S.externalId, hit.externalId)) });
  if (sig) await refreshSignature(sig).catch((err) => logger.warn({ err, sig: sig.id }, 'e-signature webhook refresh failed'));
  return { ok: true, headers: answer };
}

/** Every 15 minutes: check requests not heard of for 10 minutes (webhooks can be missed). */
export async function runSignatureChecks() {
  const due = await db.select().from(S).where(and(eq(S.status, 'SENT'), or(isNull(S.lastCheckedAt), lt(S.lastCheckedAt, new Date(Date.now() - 10 * 60_000))))).limit(100);
  let n = 0;
  for (const sig of due.filter((x) => x.externalId)) { try { await refreshSignature(sig); n++; } catch (err) { logger.warn({ err, sig: sig.id }, 'e-signature check failed'); } }
  return { checked: n };
}
defineJob('contracts.esign', async () => { await runSignatureChecks(); });

/* ---------------- endings ---------------- */

async function complete(t: Tenant, sig: ContractSignature, signedPdf: Buffer) {
  const c = await getContract(t.id, sig.contractId);
  const stored = await storeUpload(t.id, `contracts/${c.id}`, { buffer: signedPdf, originalname: `${c.number} signed.pdf` }, { types: ['application/pdf'] });
  const [file] = await db.insert(F).values({ tenantId: t.id, contractId: c.id, kind: 'SIGNED', ...stored, uploadedByName: providerOf(sig.provider)?.label ?? sig.provider }).returning();
  if (sig.signedFileId && sig.signedFileId !== file.id) await db.delete(F).where(and(eq(F.id, sig.signedFileId), eq(F.kind, 'SIGNING')));
  const [done] = await db.update(S).set({ status: 'COMPLETED', signedFileId: file.id, completedAt: new Date() }).where(and(eq(S.id, sig.id), eq(S.status, 'SENT'))).returning();
  if (!done) return;
  const status = c.type !== 'amendment' && c.endDate && c.endDate < today() ? 'EXPIRED' : 'ACTIVE';
  const [signedRow] = await db.update(C).set({ status, signedDate: today() }).where(eq(C.id, c.id)).returning();
  await sigAudit(t, c, providerOf(sig.provider)?.label ?? sig.provider, 'CONTRACT_SIGNED', { signedDate: today(), status, provider: sig.provider });
  await (await import('./manage.js')).onSigned(t, signedRow, providerOf(sig.provider)?.label ?? sig.provider);
  await tellOwner(c, `Signed: ${c.number} ${c.title}`, `${c.number} “${c.title}” is signed by everyone and is now ${status === 'ACTIVE' ? 'active' : 'recorded (its end date has passed)'}. The signed copy is on the contract.`);
  for (const s of sig.signers.filter((x) => x.side === 'PARTY')) {
    const link = await issueLink(t, { ...c, status }, s);
    await mailSupplier(defaultSupplierLanguage(t), { tenantId: t.id, to: s.email, link }, 'contractSigned', { first: s.name.split(' ')[0], buyer: t.name, title: c.title, number: c.number });
  }
}
async function stopped(t: Tenant, sig: ContractSignature, state: 'DECLINED' | 'EXPIRED' | 'CANCELLED') {
  const [row] = await db.update(S).set({ status: state }).where(and(eq(S.id, sig.id), eq(S.status, 'SENT'))).returning();
  if (!row) return;
  const c = await getContract(t.id, sig.contractId);
  await db.update(C).set({ status: sig.previousStatus }).where(eq(C.id, c.id));
  await sigAudit(t, c, providerOf(sig.provider)?.label ?? sig.provider, `CONTRACT_SIGNATURE_${state}`);
  if (state !== 'CANCELLED') await tellOwner(c, `Signature ${state === 'DECLINED' ? 'declined' : 'expired'}: ${c.number} ${c.title}`, `The signature request for ${c.number} “${c.title}” was ${state === 'DECLINED' ? 'declined by a signer' : 'not completed in time'}. Open the contract to send it again.`);
}
export async function cancelSignature(t: Tenant, contractId: string, raw: unknown, by: By) {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }).parse(raw);
  const sig = await openSignature(contractId);
  if (!sig) throw new HttpError(409, 'There is no signature request out.');
  const { p, cfg } = providerFor(sig, t);
  if (p.kind === 'email' && sig.externalId) {
    try { await p.cancel(cfg, sig.externalId, reason); } catch (e) { throw new HttpError(502, `The provider couldn’t cancel it — ${(e as Error).message}`); }
  }
  await stopped(t, sig, 'CANCELLED');
  const c = await getContract(t.id, contractId);
  await sigAudit(t, c, by.name, 'CONTRACT_SIGNATURE_CANCELLED_BY', { reason }, by.ip);
}

/* ---------------- views ---------------- */

const signerView = (s: SignatureSigner) => ({ name: s.name, email: s.email, side: s.side, order: s.order, status: s.status, signedAt: s.signedAt ?? null, method: s.method ?? null });
/** For the staff contract page. */
export async function signingView(t: Tenant, c: Contract, userEmail: string) {
  const sigs = await db.select().from(S).where(eq(S.contractId, c.id));
  const latest = sigs.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0] ?? null;
  const active = activeProvider(t);
  const party = await getParty(t.id, c.partyId);
  const us = (t.settings.contracts as { company?: { signatoryName?: string } } | undefined)?.company;
  const turn = latest && latest.status === 'SENT' ? turnOf(latest) : -1;
  return {
    provider: active ? { key: active.provider.key, label: active.provider.label, kind: active.provider.kind, methods: active.provider.methods } : null,
    request: latest && { id: latest.id, provider: providerOf(latest.provider)?.label ?? latest.provider, kind: providerOf(latest.provider)?.kind ?? 'email', status: latest.status, error: latest.error, sentAt: latest.sentAt, sentByName: latest.sentByName, completedAt: latest.completedAt, lastCheckedAt: latest.lastCheckedAt, signers: latest.signers.map(signerView) },
    myTurn: !!latest && latest.status === 'SENT' && providerOf(latest.provider)?.kind === 'link' && turn >= 0 && latest.signers[turn].side === 'US' && latest.signers[turn].email === userEmail.toLowerCase(),
    suggested: [...party.contacts.filter((x) => x.signatory && x.email).map((x) => ({ name: x.name, email: x.email!, side: 'PARTY' as const })), ...(us?.signatoryName ? [{ name: us.signatoryName, email: '', side: 'US' as const }] : [])],
  };
}
/** For the other party (review or supplier portal): the signers and whether it's this person's turn. */
export async function signingForParty(t: Tenant, c: Contract, email: string) {
  const sig = await db.query.contractSignatures.findFirst({ where: and(eq(S.contractId, c.id), inArray(S.status, ['SENT', 'COMPLETED'])), orderBy: (x, { desc }) => desc(x.sentAt) });
  if (!sig) return null;
  const p = providerOf(sig.provider);
  const turn = sig.status === 'SENT' ? turnOf(sig) : -1;
  return {
    provider: p?.label ?? sig.provider, kind: p?.kind ?? 'email', status: sig.status, test: sig.provider === 'test',
    signers: sig.signers.map((s) => ({ name: s.name, side: s.side, status: s.status, signedAt: s.signedAt ?? null })),
    myTurn: sig.status === 'SENT' && p?.kind === 'link' && turn >= 0 && sig.signers[turn].side === 'PARTY' && sig.signers[turn].email === email.toLowerCase(),
  };
}
export { revokeReviewers };
