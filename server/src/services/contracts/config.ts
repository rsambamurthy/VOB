/**
 * Contracts configuration — the one place that decides what is switched on (same layers as Sourcing, lib/moduleConfig.ts):
 *   plan / licence (`contracts` add-on) → workspace switch → contract types → options → rule defaults and locks.
 * Use contractsOn / typeOn / optionOn / contractRules; never read settings.contracts by hand.
 */
import type { Tenant } from '../../db/schema.js';
import { defineModule, type KindDef, type OptionDef, type RuleDef } from '../../lib/moduleConfig.js';

/* ---------------- catalogue ---------------- */

export type Direction = 'BUY' | 'SELL';
interface TypeDef extends KindDef { prefix: string; directions: Direction[] }
/** Contract types. `prefix` numbers them per type and year (MSA-2026-0001); `directions`: supplier (BUY) and / or customer (SELL). */
export const CONTRACT_TYPES = {
  nda: { label: 'Non-disclosure agreement (NDA)', help: 'Confidentiality before sharing information — with suppliers or customers.', prefix: 'NDA', directions: ['BUY', 'SELL'], available: true },
  msa: { label: 'Master agreement (MSA)', help: 'The umbrella terms; statements of work and orders sit under it.', prefix: 'MSA', directions: ['BUY', 'SELL'], available: true },
  sow: { label: 'Statement of work / work order', help: 'A piece of work under a master agreement: scope, deliverables, price.', prefix: 'SOW', directions: ['BUY', 'SELL'], available: true },
  supply: { label: 'Supply / rate contract', help: 'Agreed prices for goods or services over a period; orders are placed against it.', prefix: 'RC', directions: ['BUY'], available: true },
  service: { label: 'Service / maintenance contract (AMC)', help: 'Services over a period with service levels — e.g. an annual maintenance contract.', prefix: 'SVC', directions: ['BUY', 'SELL'], available: true },
  purchase: { label: 'Purchase agreement', help: 'A one-off purchase with its own terms.', prefix: 'PA', directions: ['BUY'], available: true },
  sales: { label: 'Sales agreement', help: 'Selling goods or services to a customer.', prefix: 'SA', directions: ['SELL'], available: true },
  distribution: { label: 'Distribution / reseller agreement', help: 'A partner sells your products in a territory.', prefix: 'DA', directions: ['SELL'], available: true },
  lease: { label: 'Lease / rental', help: 'Premises, equipment or vehicles.', prefix: 'LSE', directions: ['BUY', 'SELL'], available: true },
  licence: { label: 'Licence / subscription', help: 'Software or intellectual property used under licence.', prefix: 'LIC', directions: ['BUY', 'SELL'], available: true },
  other: { label: 'Other', help: 'Anything else.', prefix: 'CON', directions: ['BUY', 'SELL'], available: true },
} as const satisfies Record<string, TypeDef>;
export type ContractType = keyof typeof CONTRACT_TYPES;
export const CONTRACT_TYPE_KEYS = Object.keys(CONTRACT_TYPES) as ContractType[];

export type OptionArea = 'parties' | 'repository' | 'authoring' | 'negotiation' | 'signature' | 'management' | 'integrations' | 'ai';
export const AREA_LABELS: Record<OptionArea, string> = {
  parties: 'Parties', repository: 'Repository', authoring: 'Authoring and approval', negotiation: 'Negotiation', signature: 'Signature',
  management: 'Managing contracts', integrations: 'Integrations', ai: 'AI',
};
interface ContractOptionDef extends OptionDef { area: OptionArea }
/** Optional capabilities. `available` = built and released (later steps of the Contracts plan are listed as coming). */
export const OPTIONS = {
  customerContracts: { area: 'parties', label: 'Customer contracts', help: 'Contracts where you sell — with customers — as well as supplier contracts.', default: true, available: true },
  linkSuppliers: { area: 'parties', label: 'Link supplier parties to onboarded suppliers', help: 'A supplier party can be linked to its supplier record, showing its status and risk; new supplier parties can be sent for onboarding.', default: true, available: true, requires: 'onboarding' },
  contractHierarchy: { area: 'repository', label: 'Linked contracts', help: 'Statements of work and orders sit under a master agreement.', default: true, available: true },
  excelImport: { area: 'repository', label: 'Import existing contracts from Excel', help: 'Bring in contracts signed before VendorGate, with their dates and values.', default: true, available: true },
  templates: { area: 'authoring', label: 'Templates and clause library', help: 'Draft contracts from templates with standard and fallback clauses.', default: true, available: false },
  wordTemplates: { area: 'authoring', label: 'Your own Word templates', help: 'Upload Word templates with merge fields; contracts come out as Word and PDF.', default: true, available: false },
  internalApproval: { area: 'authoring', label: 'Internal approval', help: 'Contracts go through approval levels (by value, type or non-standard clauses) before they are sent.', default: true, available: false },
  counterpartyPortal: { area: 'negotiation', label: 'Counterparty review in the portal', help: 'Suppliers and customers review, comment and propose changes online.', default: true, available: false },
  esign: { area: 'signature', label: 'E-signature', help: 'Send for signature through the connector set up in Integrations (DocuSign, Aadhaar eSign / DSC, Adobe Sign, UAE Pass, Zoho Sign).', default: false, available: false },
  obligations: { area: 'management', label: 'Obligations and milestones', help: 'Deliverables, service levels and payment milestones with owners and reminders.', default: true, available: false },
  renewalAlerts: { area: 'management', label: 'Renewal and notice alerts', help: 'Remind the owner before the notice date and the end date.', default: true, available: false },
  priceCompliance: { area: 'management', label: 'Order and invoice price checks', help: 'Compare purchase order and invoice prices with the contract price.', default: true, available: false, requires: 'collab' },
  contractToErp: { area: 'integrations', label: 'Send contracts to the ERP', help: 'Create the blanket agreement / contract in the connected ERP when it becomes active.', default: false, available: false, requires: 'erp' },
  aiExtraction: { area: 'ai', label: 'Read uploaded contracts', help: 'Suggest the dates, value, parties and renewal terms from an uploaded contract.', default: false, available: false, requires: 'ai' },
} as const satisfies Record<string, ContractOptionDef>;
export type ContractOption = keyof typeof OPTIONS;

/** Rule defaults for new contracts. The administrator sets the default and whether contract owners may change it. */
export const RULES = {
  noticeDays: { kind: 'number', label: 'Notice period', help: 'Days of notice needed to end or not renew a contract.', min: 0, max: 730, step: 1, unit: 'days', default: 30 },
  renewalTermMonths: { kind: 'number', label: 'Renewal term', help: 'How long an automatically renewing contract runs again.', min: 1, max: 120, step: 1, unit: 'months', default: 12 },
  expiringDays: { kind: 'number', label: 'Show as expiring', help: 'Contracts ending within this many days are marked “Expiring”.', min: 7, max: 365, step: 1, unit: 'days', default: 90 },
  valueRequired: { kind: 'choice', label: 'Contract value', help: 'Whether a value must be entered.', options: { optional: 'Optional', required: 'Required (except NDAs)' }, default: 'optional' },
} as const satisfies Record<string, RuleDef>;
export type ContractRule = keyof typeof RULES;

/* ---------------- effective configuration ---------------- */

const M = defineModule({
  name: 'Contracts', feature: 'contracts', settingsKey: 'contracts', kindsKey: 'types', kindNoun: 'contract type',
  kinds: CONTRACT_TYPES, options: OPTIONS, areas: AREA_LABELS, rules: RULES as Record<ContractRule, RuleDef>,
  keep: ['approval'],
});

export const contractsSettingsSchema = M.settingsSchema;
export const contractsLicensed = M.licensed;
export const contractsOn = M.on;
export const typeState = M.kindState;
export const typeOn = (t: Tenant, k: ContractType) => M.kindState(t, k).on;
export const optionOn = M.optionOn;
export const assertContractsOn = M.assertOn;
export const assertTypeOn = M.assertKindOn;
export const contractRules = (t: Tenant, choices: Partial<Record<ContractRule, unknown>> = {}) => M.resolveRules(t, choices, 'contract');
export const ruleDefaults = M.ruleDefaults;
export const checkContractsSettings = M.checkSettings;
export type ContractsSettings = ReturnType<typeof M.stored>;

/** Directions in use: customer contracts can be switched off. */
export const directionsOn = (t: Tenant): Direction[] => (optionOn(t, 'customerContracts') ? ['BUY', 'SELL'] : ['BUY']);

/** Everything the configuration screen needs. */
export function contractsConfig(t: Tenant) {
  const { kinds, ...c } = M.config(t);
  // Sent and saved as `types` (the settings key), like Sourcing's `formats`.
  return { ...c, types: kinds.map((k) => ({ ...k, prefix: CONTRACT_TYPES[k.key].prefix, directions: CONTRACT_TYPES[k.key].directions })) };
}
/** Short version for the session (menus): what's on, which types and directions. */
export function contractsSummary(t: Tenant) {
  const s = M.summary(t);
  return { on: s.on, types: s.kinds.map((k) => ({ key: k, label: CONTRACT_TYPES[k].label, directions: CONTRACT_TYPES[k].directions })), directions: directionsOn(t), linkSuppliers: optionOn(t, 'linkSuppliers') };
}
