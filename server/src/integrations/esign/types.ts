/**
 * E-signature connectors. Two kinds:
 *   email — the provider emails each signer and collects the signatures (DocuSign, Adobe Acrobat Sign, Zoho Sign,
 *           Digio for Aadhaar eSign / DSC). VendorGate sends the PDF, then follows the status (webhook + polling)
 *           and downloads the signed PDF when everyone has signed.
 *   link  — each signer signs from a button in VendorGate (UAE PASS, which needs the signer's own UAE PASS login,
 *           and the built-in Test provider). One signer at a time; the PDF signed so far goes to the next.
 * Credentials are stored encrypted in the workspace settings and never sent back to the browser.
 */
export interface ProviderField { key: string; label: string; secret?: boolean; optional?: boolean; help?: string; options?: Record<string, string> }
export interface SignerIn { name: string; email: string; side: 'US' | 'PARTY'; order: number }
export interface SendRequest { title: string; message: string; pdf: Buffer; fileName: string; signers: SignerIn[]; callbackUrl: string; reference: string }
export type SignerState = 'SENT' | 'SIGNED' | 'DECLINED';
export interface StatusResult { state: 'SENT' | 'COMPLETED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED'; signers: { email: string; status: SignerState; signedAt?: string }[] }
export type Cfg = Record<string, string> & { sandbox?: string };

interface Base {
  key: string; label: string; help: string;
  /** Signature methods shown to users, e.g. "Aadhaar OTP", "DSC token". */
  methods: string[];
  fields: ProviderField[];
  /** Check the credentials (gets a token or reads the account). Throws a readable error. */
  check(cfg: Cfg): Promise<string>;
}
export interface EmailProvider extends Base {
  kind: 'email';
  send(cfg: Cfg, req: SendRequest): Promise<{ externalId: string }>;
  status(cfg: Cfg, externalId: string): Promise<StatusResult>;
  download(cfg: Cfg, externalId: string): Promise<Buffer>;
  cancel(cfg: Cfg, externalId: string, reason: string): Promise<void>;
  /** Identify (and verify, where the provider signs its calls) a webhook. Null = not for us / not verified. */
  webhook(cfg: Cfg, headers: Record<string, string | string[] | undefined>, raw: Buffer): { externalId: string } | null;
  /** Headers some providers want echoed on webhook answers (Adobe's client id check). */
  webhookAnswer?(headers: Record<string, string | string[] | undefined>): Record<string, string>;
}
export interface LinkProvider extends Base {
  kind: 'link';
  /** Start one signer's signature on the PDF signed so far; answer where to send their browser. */
  start(cfg: Cfg, args: { pdf: Buffer; fileName: string; signer: SignerIn; callbackUrl: string; reference: string }): Promise<{ processId: string; url: string; state?: string }>;
  /** After the browser comes back: the PDF with this signer's signature added. */
  finish(cfg: Cfg, args: { processId: string; state?: string; pdf: Buffer; signer: SignerIn; query: Record<string, string> }): Promise<Buffer>;
}
export type ESignProvider = EmailProvider | LinkProvider;

export class ProviderError extends Error {
  constructor(public provider: string, message: string, public status?: number) { super(`${provider}: ${message}`); }
}
