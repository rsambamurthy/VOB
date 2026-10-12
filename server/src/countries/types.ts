/**
 * Country packs: everything that differs by country lives in a pack; the rest of VendorGate is shared.
 *
 * Two countries matter for a vendor:
 *  - the workspace's HOME country (tenants.country) decides how the workspace runs: currency and
 *    number format, which vendors are domestic, the starting onboarding template, the privacy notice,
 *    and how the ERP record is built;
 *  - the SUPPLIER's country (profile basic.supplierCountry / bank.bankCountry) decides which identity,
 *    tax and bank rules apply to that supplier: field formats, online checks, document reading.
 *
 * Packs can extend another pack (e.g. SA extends a shared GCC pack) and only declare what differs.
 * Field formats ("validators"), online checks and readable document types are global by name, so a
 * workspace in any country can use India's GSTIN check for its Indian suppliers.
 */
import type { OnboardingConfig } from '../config/types.js';

export type Profile = Record<string, Record<string, unknown>>;

export interface ValidatorCtx { country?: string }
export interface ValidatorDef {
  /** Shown in the configuration editor's "Format check" list. */
  label: string;
  check: (value: string, ctx: ValidatorCtx) => string | null;
  /** Stored upper-case with spaces removed (identifiers like GSTIN, IBAN). */
  upper?: boolean;
}

/** A per-country format for a generic field (postal code, bank account number). */
export interface FormatRule { pattern: RegExp; message: string }

/* ---------- Online verification ---------- */

export type CheckStatus = 'VERIFIED' | 'NOT_FOUND' | 'INVALID_FORMAT' | 'ERROR';
export interface CheckResult { status: CheckStatus; message: string; nameOnRecord?: string; data?: Record<string, string> }
export interface CheckProvider { name: string; live: boolean; check(kind: string, input: Record<string, string>, ctx: { legalName: string }): Promise<CheckResult> }

export interface CheckDef {
  /** Stored on each result, e.g. "gstin". Unique across all packs. */
  kind: string;
  /** Reviewer-facing name, e.g. "GSTIN", "Bank account". */
  label: string;
  /** Field that gets the vendor's "Verify" button. */
  anchor: string;
  buttonLabel?: string;
  /** Provider input → profile field it is read from. */
  inputs: Record<string, string>;
  /** Field compared with the name on record (default: the vendor's legal name). */
  nameField?: string;
  /** Clean the input, mask it for display, and say why it can't be checked yet. */
  normalise(raw: Record<string, string>): { input: Record<string, string>; masked: string; error?: string };
  /** Re-run when the vendor changes their bank details (fraud control). */
  onBankChange?: boolean;
  /**
   * 'supplier' (default): offered wherever the field it reads is on the form (e.g. GSTIN for Indian suppliers).
   * 'home': offered for every supplier, but only in workspaces whose home pack includes it (e.g. sanctions screening in the Gulf).
   */
  scope?: 'supplier' | 'home';
  /** Badge wording when the meaning of VERIFIED / NOT_FOUND differs (sanctions: "Clear" / "Possible match"). */
  resultLabels?: { ok: string; fail: string };
  /** Run automatically when the supplier submits for review. */
  runOnSubmit?: boolean;
}

/* ---------- Document reading (AI) ---------- */

export interface ExtractKey { key: string; description: string; target: string; validate?: (v: string) => boolean; transform?: (v: string) => string }
export interface ExtractedField { fieldId: string; label: string; value: string; confidence: number }
export interface ReadableDocument {
  /** How the AI is told what it is looking at, e.g. "GST registration certificate (Form GST REG-06)". */
  label: string;
  keys: ExtractKey[];
}

/* ---------- The pack ---------- */

export interface CountryPack {
  /** ISO 3166-1 alpha-2 ("IN"), or an internal id for shared packs ("GCC"). */
  code: string;
  /** The name used in the supplier-country dropdowns ("India"). */
  name: string;
  extends?: string;
  /** Can be chosen as a workspace's home country (needs a template). */
  homeCountry?: boolean;

  currency?: string;
  /** BCP 47 locale for dates and numbers ("en-IN"). */
  locale?: string;
  /** Days off, 0 = Sunday … 6 = Saturday. */
  weekend?: number[];
  /** New workspaces count deadlines in working days (skip the weekend). */
  skipWeekendsByDefault?: boolean;
  /** IANA zone used for deadlines in emails, and its short label ("IST", "AST"). */
  timeZone?: string;
  timeZoneLabel?: string;
  /** HOME pack: fields its template relies on (ERP mapping, checks) — can be moved/relabelled, not deleted. */
  coreFields?: string[];

  /** Format checks this pack adds (global by name). */
  validators?: Record<string, ValidatorDef>;
  /** Country-specific formats for generic fields. */
  formats?: { postalCode?: FormatRule; bankAccount?: FormatRule; vatNumber?: FormatRule };
  /** Consistency checks between fields for suppliers from this country. */
  crossChecks?: (p: Profile) => { field: string; message: string }[];

  /** Online checks this pack adds, and the provider that runs them. */
  checks?: CheckDef[];
  checkProvider?: () => CheckProvider;
  /** One line for the Integrations page, e.g. "GSTIN / PAN / bank / MCA checks". */
  checksTitle?: string;

  /** Documents the AI can read for suppliers from this country (global by document code). */
  documents?: Record<string, ReadableDocument>;
  /** Values implied by other extracted values (e.g. the PAN inside a GSTIN). */
  deriveExtracted?: (fields: ExtractedField[]) => ExtractedField[];

  /** HOME pack: starting onboarding template for new workspaces. */
  template?: () => OnboardingConfig;
  /** HOME pack: privacy law the notice is written for, and its default text. */
  privacy?: { law: string; lawShort: string; defaultNotice: (company: string, contactEmail?: string) => string };
  /** ERP export. Domestic = the supplier is from the workspace's home country. */
  erp?: {
    /** Tax registration number sent as the domestic VAT/GST number. */
    domesticTaxId?: (p: Profile) => string;
    /** Extra block for domestic suppliers, e.g. INDIA_LOCALIZATION. */
    domesticBlock?: (p: Profile) => { key: string; value: Record<string, string> };
    /** Extra block for foreign suppliers (withholding tax details). */
    foreignBlock?: (p: Profile) => { key: string; value: Record<string, string> };
    /** Field holding the bank branch code for banks in this country (India: IFSC). */
    bankBranchField?: string;
  };
}
