/**
 * Built-in clause library and templates (India + GCC), seeded into each workspace the first time Contracts templates
 * are used. Workspaces edit their copy; "Reset to standard" restores the built-in wording.
 *
 * The wording is a sound commercial starting point, not legal advice: each workspace's counsel should review it.
 * In clauses, {{party.role}} is the other party (Supplier / Customer) and {{us.role}} is us (Buyer / Seller).
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';

export interface BuiltInClause { group: string; jurisdiction: 'ALL' | 'IN' | 'AE' | 'SA'; title: string; category: string; body: string; fallbacks?: { key: string; label: string; body: string }[]; guidance?: string }
export interface BuiltInTemplate { key: string; name: string; types: string[]; direction: 'BUY' | 'SELL' | 'BOTH'; heading: string; preamble: string; sections: string[]; optional?: string[] }

const PREAMBLE = 'This agreement (the “Agreement”) is made on {{today}} between {{us.legalName}}, {{us.address}} (the “{{us.role}}”), and {{party.legalName}}, {{party.address}} (the “{{party.role}}”). The {{us.role}} and the {{party.role}} are each a “Party” and together the “Parties”.';

export const BUILT_IN_CLAUSES: BuiltInClause[] = [
  /* ---------- amendments ---------- */
  { group: 'amendment-changes', jurisdiction: 'ALL', title: 'Amendment', category: 'Amendments',
    body: 'This Amendment changes {{parent.title}} ({{parent.number}}) signed on {{parent.signedDate}} (the “Agreement”). With effect from {{contract.startDate}}, the Agreement is changed as follows:\n{{amendment.changes}}' },
  { group: 'amendment-rest', jurisdiction: 'ALL', title: 'Rest of the Agreement', category: 'Amendments',
    body: 'Except as changed by this Amendment, the Agreement remains unchanged and in full force. Words defined in the Agreement have the same meaning in this Amendment. If this Amendment and the Agreement conflict, this Amendment prevails.' },
  /* ---------- commercial ---------- */
  { group: 'scope', jurisdiction: 'ALL', title: 'Scope', category: 'Commercial',
    body: 'The {{party.role}} shall provide the goods and / or services described below and in any schedule to this Agreement (the “Deliverables”), with due skill, care and diligence and in line with good industry practice:\n{{contract.description}}' },
  { group: 'term', jurisdiction: 'ALL', title: 'Term', category: 'Commercial',
    body: 'This Agreement starts on {{contract.startDate}} and continues until {{contract.endDate}}, unless ended earlier under this Agreement.',
    fallbacks: [{ key: 'renew', label: 'Renews automatically', body: 'This Agreement starts on {{contract.startDate}} and continues until {{contract.endDate}}. It then renews automatically for further periods of {{contract.renewalTermMonths}} months each, unless either Party gives the other at least {{contract.noticeDays}} days’ written notice before the end of the current period that it will not renew.' }],
    guidance: 'Use “Renews automatically” only when the contract is marked to renew; the notice period comes from the contract.' },
  { group: 'price-payment', jurisdiction: 'ALL', title: 'Price and payment', category: 'Commercial',
    body: 'The total consideration under this Agreement is {{contract.value}} ({{contract.valueInWords}}), excluding taxes. The {{party.role}} shall invoice in line with this Agreement, and the {{us.role}} shall pay each undisputed and correct invoice within thirty (30) days of receiving it. Prices are fixed for the term unless the Parties agree otherwise in writing.',
    fallbacks: [
      { key: 'days45', label: 'Payment in 45 days', body: 'The total consideration under this Agreement is {{contract.value}} ({{contract.valueInWords}}), excluding taxes. The {{us.role}} shall pay each undisputed and correct invoice within forty-five (45) days of receiving it. Prices are fixed for the term unless the Parties agree otherwise in writing.' },
      { key: 'days60', label: 'Payment in 60 days', body: 'The total consideration under this Agreement is {{contract.value}} ({{contract.valueInWords}}), excluding taxes. The {{us.role}} shall pay each undisputed and correct invoice within sixty (60) days of receiving it. Prices are fixed for the term unless the Parties agree otherwise in writing.' },
      { key: 'advance', label: 'Part advance', body: 'The total consideration under this Agreement is {{contract.value}} ({{contract.valueInWords}}), excluding taxes. Twenty per cent (20%) is payable in advance against a matching advance bank guarantee, and the balance within thirty (30) days of each undisputed and correct invoice.' },
    ],
    guidance: 'Payment terms over 45 days to MSE suppliers in India conflict with the MSMED Act, 2006 (section 15) — check the supplier’s Udyam status.' },
  { group: 'taxes', jurisdiction: 'IN', title: 'Taxes (GST)', category: 'Commercial',
    body: 'Prices exclude Goods and Services Tax (GST), which shall be charged at the applicable rate on a valid tax invoice under the Central Goods and Services Tax Act, 2017 and the relevant State or Integrated GST law. The {{party.role}} shall upload its invoices on the GST portal on time so that the {{us.role}} can claim input tax credit; if credit is denied because of the {{party.role}}’s default, the {{party.role}} shall make good the loss. The {{us.role}} may deduct tax at source where the law requires it and shall issue the certificate for it.' },
  { group: 'taxes', jurisdiction: 'AE', title: 'Taxes (VAT)', category: 'Commercial',
    body: 'Prices exclude Value Added Tax (VAT), which shall be charged at the applicable rate (currently 5%) on a valid tax invoice under Federal Decree-Law No. 8 of 2017 on Value Added Tax and its executive regulations. Each Party is responsible for its own other taxes.' },
  { group: 'taxes', jurisdiction: 'SA', title: 'Taxes (VAT)', category: 'Commercial',
    body: 'Prices exclude Value Added Tax (VAT), which shall be charged at the applicable rate (currently 15%) on a valid electronic tax invoice compliant with the Value Added Tax Law and the e-invoicing (FATOORA) requirements of the Zakat, Tax and Customs Authority. Withholding tax shall be applied where the law requires it.' },
  { group: 'orders-delivery', jurisdiction: 'ALL', title: 'Orders, delivery and acceptance', category: 'Commercial',
    body: 'The {{us.role}} may place purchase orders under this Agreement at the agreed prices; each order is governed by this Agreement. The {{party.role}} shall deliver on the dates and to the places in the order. The {{us.role}} may inspect the Deliverables within fifteen (15) days of delivery and reject any that do not conform. Title and risk pass to the {{us.role}} on acceptance.',
    fallbacks: [{ key: 'ld', label: 'With liquidated damages for delay', body: 'The {{us.role}} may place purchase orders under this Agreement at the agreed prices; each order is governed by this Agreement. The {{party.role}} shall deliver on the dates and to the places in the order. For each week of delay not caused by the {{us.role}} or force majeure, the {{party.role}} shall pay liquidated damages of half a per cent (0.5%) of the value of the delayed Deliverables, up to ten per cent (10%) of that value. The {{us.role}} may inspect the Deliverables within fifteen (15) days of delivery and reject any that do not conform. Title and risk pass to the {{us.role}} on acceptance.' }] },
  { group: 'service-levels', jurisdiction: 'ALL', title: 'Service levels', category: 'Commercial',
    body: 'The {{party.role}} shall meet the service levels in the schedule, including response and resolution times for breakdowns, preventive maintenance visits and uptime. If a service level is missed, the {{party.role}} shall give a credit as set out in the schedule; repeated failures in three (3) consecutive months are a material breach.' },
  /* ---------- legal ---------- */
  { group: 'warranties', jurisdiction: 'ALL', title: 'Warranties', category: 'Legal',
    body: 'The {{party.role}} warrants that the Deliverables will conform to this Agreement, be free from defects in design, materials and workmanship for twelve (12) months from acceptance, and comply with applicable law. The {{party.role}} shall repair or replace any defective Deliverable promptly and at its own cost.',
    fallbacks: [{ key: 'months24', label: '24-month warranty', body: 'The {{party.role}} warrants that the Deliverables will conform to this Agreement, be free from defects in design, materials and workmanship for twenty-four (24) months from acceptance, and comply with applicable law. The {{party.role}} shall repair or replace any defective Deliverable promptly and at its own cost.' }] },
  { group: 'ip', jurisdiction: 'ALL', title: 'Intellectual property', category: 'Legal',
    body: 'Each Party keeps its own intellectual property existing before this Agreement. Intellectual property in Deliverables created specifically for the {{us.role}} and paid for under this Agreement belongs to the {{us.role}} on payment. The {{party.role}} grants the {{us.role}} a perpetual, royalty-free licence to use any of its existing intellectual property included in the Deliverables, to the extent needed to use them.',
    fallbacks: [{ key: 'licence', label: 'Supplier keeps ownership, licence to us', body: 'Each Party keeps its own intellectual property. The {{party.role}} owns the intellectual property in the Deliverables and grants the {{us.role}} a non-exclusive, perpetual, royalty-free licence to use them for its business.' }] },
  { group: 'confidentiality', jurisdiction: 'ALL', title: 'Confidentiality', category: 'Confidentiality',
    body: 'Each Party shall keep confidential all information the other Party discloses in connection with this Agreement that is marked confidential or would reasonably be understood to be confidential, use it only for this Agreement, and disclose it only to its employees and advisers who need to know it and are bound by similar duties. This does not apply to information that is public through no fault of the receiving Party, already known to it, independently developed, or required to be disclosed by law or a regulator (after notice to the other Party where allowed). These duties continue for three (3) years after this Agreement ends.',
    fallbacks: [{ key: 'years5', label: 'Five years after the end', body: 'Each Party shall keep confidential all information the other Party discloses in connection with this Agreement that is marked confidential or would reasonably be understood to be confidential, use it only for this Agreement, and disclose it only to its employees and advisers who need to know it and are bound by similar duties. This does not apply to information that is public through no fault of the receiving Party, already known to it, independently developed, or required to be disclosed by law or a regulator (after notice to the other Party where allowed). These duties continue for five (5) years after this Agreement ends, and for trade secrets for as long as they remain secret.' }] },
  { group: 'nda-purpose', jurisdiction: 'ALL', title: 'Purpose', category: 'Confidentiality',
    body: 'The Parties wish to share confidential information to evaluate and, if they agree, carry out a possible business relationship concerning: {{contract.description}} (the “Purpose”). Nothing in this Agreement obliges either Party to enter into any further agreement.' },
  { group: 'return-information', jurisdiction: 'ALL', title: 'Return of information', category: 'Confidentiality',
    body: 'On request, or when the Purpose ends, the receiving Party shall return or destroy the other Party’s confidential information and confirm this in writing, except copies it must keep by law or in routine back-ups, which remain confidential.' },
  { group: 'data-protection', jurisdiction: 'IN', title: 'Personal data', category: 'Data protection',
    body: 'Where a Party processes personal data on behalf of the other, it shall do so only on the other Party’s documented instructions and in line with the Digital Personal Data Protection Act, 2023 and the rules under it, keep the data secure with reasonable security safeguards, tell the other Party without undue delay of any personal data breach, and delete or return the data when the processing ends.' },
  { group: 'data-protection', jurisdiction: 'AE', title: 'Personal data', category: 'Data protection',
    body: 'Where a Party processes personal data on behalf of the other, it shall do so only on the other Party’s documented instructions and in line with Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data (and, where applicable, the data protection law of a free zone), keep the data secure, tell the other Party without undue delay of any breach, and not transfer the data outside the UAE except as the law allows.' },
  { group: 'data-protection', jurisdiction: 'SA', title: 'Personal data', category: 'Data protection',
    body: 'Where a Party processes personal data on behalf of the other, it shall do so only on the other Party’s documented instructions and in line with the Personal Data Protection Law and its implementing regulations issued by the Saudi Data and AI Authority (SDAIA), keep the data secure, tell the other Party without undue delay of any breach, and not transfer the data outside the Kingdom except as the law allows.' },
  { group: 'liability', jurisdiction: 'ALL', title: 'Limitation of liability', category: 'Legal',
    body: 'Neither Party is liable for indirect or consequential loss, or loss of profit, revenue or goodwill. Each Party’s total liability under this Agreement is limited to the total consideration paid and payable under it. These limits do not apply to breach of confidentiality, the indemnities in this Agreement, fraud, wilful misconduct, or death or personal injury caused by negligence.',
    fallbacks: [
      { key: 'cap2x', label: 'Cap at twice the value', body: 'Neither Party is liable for indirect or consequential loss, or loss of profit, revenue or goodwill. Each Party’s total liability under this Agreement is limited to twice (2×) the total consideration paid and payable under it. These limits do not apply to breach of confidentiality, the indemnities in this Agreement, fraud, wilful misconduct, or death or personal injury caused by negligence.' },
      { key: 'cap12m', label: 'Cap at 12 months’ fees', body: 'Neither Party is liable for indirect or consequential loss, or loss of profit, revenue or goodwill. Each Party’s total liability under this Agreement is limited to the amounts paid and payable in the twelve (12) months before the claim. These limits do not apply to breach of confidentiality, fraud, wilful misconduct, or death or personal injury caused by negligence.' },
    ] },
  { group: 'indemnity', jurisdiction: 'ALL', title: 'Indemnity', category: 'Legal',
    body: 'The {{party.role}} shall indemnify the {{us.role}} against all losses, claims and costs arising from (a) any claim that the Deliverables infringe a third party’s intellectual property, (b) the {{party.role}}’s breach of law, and (c) death, personal injury or damage to property caused by the {{party.role}}’s negligence, provided the {{us.role}} promptly notifies the claim and allows the {{party.role}} to conduct its defence.' },
  { group: 'anti-bribery', jurisdiction: 'ALL', title: 'Anti-bribery and compliance', category: 'Compliance',
    body: 'Each Party shall comply with all applicable anti-bribery and anti-corruption laws, shall not offer, give or accept any bribe or improper payment in connection with this Agreement, and shall keep accurate records of its dealings under it. Each Party shall comply with applicable sanctions and export-control laws. A breach of this clause is a material breach that cannot be remedied.' },
  { group: 'termination', jurisdiction: 'ALL', title: 'Termination', category: 'Legal',
    body: 'Either Party may end this Agreement by giving the other at least {{contract.noticeDays}} days’ written notice. Either Party may end it immediately by written notice if the other (a) commits a material breach and, where it can be remedied, does not remedy it within thirty (30) days of being asked to, or (b) becomes insolvent or subject to insolvency proceedings. On termination the {{us.role}} pays for Deliverables properly supplied up to the termination date, and clauses meant to survive (including confidentiality, liability and disputes) continue.',
    fallbacks: [{ key: 'cause', label: 'Only for breach or insolvency', body: 'Either Party may end this Agreement immediately by written notice if the other (a) commits a material breach and, where it can be remedied, does not remedy it within thirty (30) days of being asked to, or (b) becomes insolvent or subject to insolvency proceedings. On termination the {{us.role}} pays for Deliverables properly supplied up to the termination date, and clauses meant to survive (including confidentiality, liability and disputes) continue.' }] },
  { group: 'force-majeure', jurisdiction: 'ALL', title: 'Force majeure', category: 'Legal',
    body: 'Neither Party is liable for delay or failure caused by events beyond its reasonable control, such as natural disasters, epidemics, war, riots, acts of government or failure of public utilities, provided it promptly notifies the other Party and does its best to limit the effect. If such an event continues for more than sixty (60) days, either Party may end this Agreement by written notice.' },
  { group: 'governing-law', jurisdiction: 'IN', title: 'Governing law', category: 'Legal',
    body: 'This Agreement is governed by the laws of India. Subject to the clause on disputes, the courts at {{us.city}} have exclusive jurisdiction.' },
  { group: 'governing-law', jurisdiction: 'AE', title: 'Governing law', category: 'Legal',
    body: 'This Agreement is governed by the federal laws of the United Arab Emirates and the laws of the Emirate of {{us.city}} as applied there. Subject to the clause on disputes, the courts of {{us.city}} have exclusive jurisdiction.',
    fallbacks: [{ key: 'difc', label: 'DIFC law and courts', body: 'This Agreement is governed by the laws of the Dubai International Financial Centre. Subject to the clause on disputes, the courts of the Dubai International Financial Centre have exclusive jurisdiction.' }],
    guidance: 'Use the DIFC fallback only where both parties agree to opt in to the DIFC courts.' },
  { group: 'governing-law', jurisdiction: 'SA', title: 'Governing law', category: 'Legal',
    body: 'This Agreement is governed by the laws and regulations of the Kingdom of Saudi Arabia. Subject to the clause on disputes, the competent courts in {{us.city}} have jurisdiction.' },
  { group: 'disputes', jurisdiction: 'IN', title: 'Disputes and arbitration', category: 'Legal',
    body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, the dispute shall be referred to arbitration by a sole arbitrator appointed by mutual agreement, under the Arbitration and Conciliation Act, 1996. The seat and venue of arbitration is {{us.city}}, and the language is English. The award is final and binding.',
    fallbacks: [{ key: 'courts', label: 'Courts only, no arbitration', body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, either Party may refer the dispute to the courts named in the clause on governing law, including the commercial courts under the Commercial Courts Act, 2015 where it applies.' }] },
  { group: 'disputes', jurisdiction: 'AE', title: 'Disputes and arbitration', category: 'Legal',
    body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, the dispute shall be finally resolved by arbitration under the Arbitration Rules of the Dubai International Arbitration Centre (DIAC) by a sole arbitrator. The seat of arbitration is Dubai, and the language is English.',
    fallbacks: [{ key: 'courts', label: 'Onshore courts', body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, either Party may refer the dispute to the courts named in the clause on governing law.' }] },
  { group: 'disputes', jurisdiction: 'SA', title: 'Disputes and arbitration', category: 'Legal',
    body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, the dispute shall be finally resolved by arbitration administered by the Saudi Center for Commercial Arbitration (SCCA) under its rules, in line with the Arbitration Law. The seat of arbitration is Riyadh, and the language is English (with Arabic where the law requires it).',
    fallbacks: [{ key: 'courts', label: 'Saudi courts', body: 'The Parties shall first try to settle any dispute through their senior representatives within thirty (30) days. If not settled, either Party may refer the dispute to the competent commercial court in the Kingdom of Saudi Arabia.' }] },
  { group: 'stamp-duty', jurisdiction: 'IN', title: 'Stamp duty', category: 'Legal',
    body: 'This Agreement shall be stamped as required by the applicable Stamp Act. The {{us.role}} shall bear the stamp duty, unless the Parties agree otherwise.',
    guidance: 'Stamp duty depends on the state where the agreement is signed (and where it is used). E-stamp before or on signing; an unstamped agreement can’t be relied on as evidence until duty and penalty are paid.' },
  { group: 'notices', jurisdiction: 'ALL', title: 'Notices', category: 'General',
    body: 'Notices under this Agreement must be in writing and sent by hand, courier or email to the addresses at the start of this Agreement (for the {{party.role}}, also to {{party.email}}), or to another address a Party notifies. A notice by email is received when sent, unless the sender gets a delivery failure message.' },
  { group: 'general', jurisdiction: 'ALL', title: 'General', category: 'General',
    body: 'This Agreement is the entire agreement between the Parties on its subject and replaces any earlier understanding. It may be changed only in writing signed by both Parties. Neither Party may assign it without the other’s written consent, which shall not be unreasonably withheld. If any part is held invalid, the rest remains in force. The Parties are independent contractors. This Agreement may be signed in counterparts and electronically.' },
  { group: 'language', jurisdiction: 'AE', title: 'Language', category: 'General',
    body: 'This Agreement is made in English. If it is translated into Arabic, including for any court or authority, the English text prevails between the Parties to the extent the law allows.' },
  { group: 'language', jurisdiction: 'SA', title: 'Language', category: 'General',
    body: 'This Agreement is made in English and may be translated into Arabic. Where an Arabic version is required by a court or authority in the Kingdom, the Parties shall agree the translation; between the Parties, the English text prevails to the extent the law allows.' },
];

const COMMERCIAL_END = ['anti-bribery', 'termination', 'force-majeure', 'governing-law', 'disputes', 'stamp-duty', 'notices', 'general', 'language'];
export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  { key: 'nda', name: 'Mutual non-disclosure agreement', types: ['nda'], direction: 'BOTH', heading: 'MUTUAL NON-DISCLOSURE AGREEMENT',
    preamble: 'This Mutual Non-Disclosure Agreement (the “Agreement”) is made on {{today}} between {{us.legalName}}, {{us.address}}, and {{party.legalName}}, {{party.address}}, each a “Party” and together the “Parties”.',
    sections: ['nda-purpose', 'confidentiality', 'return-information', 'term', 'data-protection', 'governing-law', 'disputes', 'stamp-duty', 'notices', 'general', 'language'] },
  { key: 'service', name: 'Service / maintenance agreement (AMC)', types: ['service'], direction: 'BOTH', heading: 'SERVICE AGREEMENT', preamble: PREAMBLE,
    sections: ['scope', 'term', 'price-payment', 'taxes', 'service-levels', 'warranties', 'confidentiality', 'data-protection', 'liability', 'indemnity', ...COMMERCIAL_END], optional: ['data-protection', 'service-levels'] },
  { key: 'supply', name: 'Supply / rate contract', types: ['supply', 'purchase'], direction: 'BUY', heading: 'SUPPLY AGREEMENT', preamble: PREAMBLE,
    sections: ['scope', 'orders-delivery', 'term', 'price-payment', 'taxes', 'warranties', 'ip', 'confidentiality', 'liability', 'indemnity', ...COMMERCIAL_END], optional: ['ip'] },
  { key: 'msa', name: 'Master services agreement', types: ['msa'], direction: 'BOTH', heading: 'MASTER SERVICES AGREEMENT',
    preamble: `${PREAMBLE} Each piece of work is agreed in a statement of work that refers to this Agreement.`,
    sections: ['scope', 'term', 'price-payment', 'taxes', 'ip', 'confidentiality', 'data-protection', 'warranties', 'liability', 'indemnity', ...COMMERCIAL_END] },
  { key: 'amendment', name: 'Amendment agreement', types: ['amendment'], direction: 'BOTH', heading: 'AMENDMENT AGREEMENT',
    preamble: 'This Amendment is made on {{today}} between {{us.legalName}}, {{us.address}} (the “{{us.role}}”), and {{party.legalName}}, {{party.address}} (the “{{party.role}}”).',
    sections: ['amendment-changes', 'amendment-rest', 'governing-law', 'stamp-duty'] },
  { key: 'sales', name: 'Sales agreement', types: ['sales', 'distribution'], direction: 'SELL', heading: 'SALES AGREEMENT', preamble: PREAMBLE,
    sections: ['scope', 'orders-delivery', 'term', 'price-payment', 'taxes', 'warranties', 'confidentiality', 'liability', ...COMMERCIAL_END] },
];

/**
 * Put the built-in library into a workspace: everything the first time, and later only what is new in a release
 * (clauses by group + country, templates by key). Edited, archived or renamed items are never touched.
 */
const checked = new Set<string>();
export async function ensureLibrary(t: Pick<Tenant, 'id'>) {
  if (checked.has(t.id)) return;
  const have = new Set((await db.select({ group: schema.contractClauses.group, jurisdiction: schema.contractClauses.jurisdiction }).from(schema.contractClauses).where(eq(schema.contractClauses.tenantId, t.id))).map((c) => `${c.group}|${c.jurisdiction}`));
  const missing = BUILT_IN_CLAUSES.filter((c) => !have.has(`${c.group}|${c.jurisdiction}`));
  if (missing.length) await db.insert(schema.contractClauses).values(missing.map((c) => ({ tenantId: t.id, group: c.group, jurisdiction: c.jurisdiction, title: c.title, category: c.category, body: c.body, fallbacks: c.fallbacks ?? [], guidance: c.guidance ?? null, builtIn: true }))).onConflictDoNothing();
  const keys = new Set((await db.select({ k: schema.contractTemplates.builtInKey }).from(schema.contractTemplates).where(and(eq(schema.contractTemplates.tenantId, t.id), eq(schema.contractTemplates.builtIn, true)))).map((r) => r.k));
  const newTemplates = BUILT_IN_TEMPLATES.filter((b) => !keys.has(b.key));
  if (newTemplates.length) await db.insert(schema.contractTemplates).values(newTemplates.map((b) => ({ tenantId: t.id, name: b.name, kind: 'CLAUSES', types: b.types, direction: b.direction, heading: b.heading, preamble: b.preamble,
    sections: b.sections.map((g) => ({ group: g, required: !(b.optional ?? []).includes(g) })), builtIn: true, builtInKey: b.key })));
  checked.add(t.id);
}
export const builtInClause = (group: string, jurisdiction: string) => BUILT_IN_CLAUSES.find((c) => c.group === group && c.jurisdiction === jurisdiction) ?? null;
