/** Building blocks shared by the Gulf country packs. */
import { baseValidators } from '../base.js';
import type { ExtractKey, Profile, ReadableDocument } from '../types.js';

/** A bank in this country must have an IBAN with its prefix and length (SA 24, AE 23, BH 22, QA 29…). */
export function ibanCountryCheck(country: string, prefix: string, length: number) {
  return (p: Profile) => {
    const iban = String(p.bank?.iban ?? '').replace(/\s+/g, '').toUpperCase();
    if (String(p.bank?.bankCountry ?? '') !== country || !iban) return [];
    return iban.startsWith(prefix) && iban.length === length ? [] : [{ field: 'bank.iban', message: `A ${country} bank account’s IBAN starts with ${prefix} and has ${length} characters` }];
  };
}

const compact = (v: string) => v.toUpperCase().replace(/\s+/g, '');
export const BANK_KEYS = {
  holder: { key: 'accountHolderName', description: 'Account holder (beneficiary) name', target: 'bank.accountHolderName' },
  iban: { key: 'iban', description: 'IBAN (starts with two letters, e.g. SA, AE, BH)', target: 'bank.iban', transform: compact, validate: (v: string) => baseValidators.iban.check(v, {}) === null },
  bankName: { key: 'bankName', description: 'Name of the bank', target: 'bank.bankName' },
  swift: { key: 'swift', description: 'SWIFT / BIC code of the bank', target: 'bank.swift', transform: compact, validate: (v: string) => baseValidators.swift.check(v, {}) === null },
} satisfies Record<string, ExtractKey>;

/** Gulf bank letters (IBAN certificates) look the same everywhere. */
export const gccDocuments: Record<string, ReadableDocument> = {
  BANK_LETTER: { label: 'bank letter or IBAN certificate', keys: [BANK_KEYS.holder, BANK_KEYS.iban, BANK_KEYS.bankName, BANK_KEYS.swift] },
};

/** Starting privacy notice for Gulf workspaces; each country supplies its law sentence and complaint route. */
export function gulfNotice(o: { lawSentence: string; abroad: string; complaint?: string }) {
  return (company: string, contactEmail?: string) => `${company} ("we") collects the information in this registration to evaluate you as a supplier, set you up in our purchasing and payment systems, pay you, and meet our legal and tax obligations.${o.lawSentence ? ` ${o.lawSentence}` : ''}

What we collect: company and contact details, commercial registration, licence and tax details, the names, nationalities and shareholdings of owners, bank account details, financial and risk information, and the documents you upload.

Why: to assess and register you as a supplier and to pay you (performing a contract with you), and to meet our legal obligations, including sanctions and anti-money-laundering checks.

How it is checked and shared: registrations may be verified with government sources and verification service providers, and names are screened against sanctions lists. Uploaded documents may be read automatically to pre-fill the form. Approved supplier records are sent to our ERP / accounting system. ${o.abroad} We do not sell your data.

How long we keep it: while you are an active supplier and afterwards for as long as tax and commercial record-keeping rules require. Registrations that are rejected or not completed are deleted after a set period.

Your rights: you can ask for access to your data, correct it (request a change in this portal), object to processing, and ask us to delete it where it is no longer needed. Some records of approved suppliers must be kept by law even after a deletion request.${o.complaint ? ` ${o.complaint}` : ''}${contactEmail ? `\n\nContact for data protection questions: ${contactEmail}` : ''}`;
}

/** The same notice in Arabic. */
export function gulfNoticeAr(o: { lawSentence: string; abroad: string; complaint?: string }) {
  return (company: string, contactEmail?: string) => `تجمع ${company} («نحن») المعلومات الواردة في هذا التسجيل لتقييمكم كمورد، وتسجيلكم في أنظمة المشتريات والمدفوعات لدينا، والسداد لكم، والوفاء بالتزاماتنا النظامية والضريبية.${o.lawSentence ? ` ${o.lawSentence}` : ''}

ما نجمعه: بيانات الشركة وجهات الاتصال، والسجل التجاري، وبيانات الرخص والضرائب، وأسماء الملاك وجنسياتهم ونسب ملكيتهم، والبيانات المصرفية، والمعلومات المالية ومعلومات المخاطر، والمستندات التي ترفعونها.

الغرض: تقييمكم وتسجيلكم كمورد والسداد لكم (تنفيذاً لعقد معكم)، والوفاء بالتزاماتنا النظامية، بما في ذلك فحص قوائم العقوبات ومكافحة غسل الأموال.

التحقق والمشاركة: قد يتم التحقق من التسجيلات لدى الجهات الحكومية ومقدمي خدمات التحقق، وتُفحص الأسماء مقابل قوائم العقوبات. وقد تُقرأ المستندات المرفوعة آلياً لتعبئة النموذج مسبقاً. وتُرسل بيانات الموردين المعتمدين إلى نظام تخطيط الموارد / النظام المحاسبي لدينا. ${o.abroad} ولا نبيع بياناتكم.

مدة الاحتفاظ: طوال فترة كونكم مورداً نشطاً، وبعدها للمدة التي تتطلبها أنظمة الضرائب وحفظ السجلات التجارية. وتُحذف التسجيلات المرفوضة أو غير المكتملة بعد مدة محددة.

حقوقكم: يحق لكم طلب الاطلاع على بياناتكم، وتصحيحها (بتقديم طلب تعديل في هذه البوابة)، والاعتراض على معالجتها، وطلب حذفها متى انتفت الحاجة إليها. ويلزم النظام الاحتفاظ ببعض سجلات الموردين المعتمدين حتى بعد طلب الحذف.${o.complaint ? ` ${o.complaint}` : ''}${contactEmail ? `\n\nللاستفسارات المتعلقة بحماية البيانات: ${contactEmail}` : ''}`;
}

/** Test-mode provider for registry lookups: numbers whose last digit is 0 come back "not found". */
export function registryMock(kinds: Record<string, { source: string; field: string }>) {
  return {
    name: 'mock', live: false,
    async check(kind: string, input: Record<string, string>, ctx: { legalName: string }) {
      const k = kinds[kind];
      if (!k) return { status: 'ERROR' as const, message: `No test provider for ${kind}` };
      const v = String(input[k.field] ?? '').replace(/[^0-9A-Za-z]/g, '');
      if (v.endsWith('0')) return { status: 'NOT_FOUND' as const, message: `Not found on ${k.source} (test mode)` };
      return { status: 'VERIFIED' as const, message: `Active on ${k.source} (test mode)`, nameOnRecord: ctx.legalName.toUpperCase(), data: { status: 'Active' } };
    },
  };
}
