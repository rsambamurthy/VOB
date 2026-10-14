/**
 * Saudi Arabia pack (extends the Gulf pack). As a HOME country: SAR, Friday–Saturday working week,
 * Saudi onboarding template (CR, VAT, Zakat, GOSI, Nitaqat, IKTVA, ownership), PDPL privacy notice,
 * sanctions screening, and a SAUDI_LOCALIZATION block in the ERP record. As a SUPPLIER country:
 * VAT/CR/postal-code formats, CR (Wathq) and VAT (ZATCA) checks, and reading CR, VAT and bank letters.
 */
import type { CountryPack, Profile } from '../types.js';
import { saChecks, saCrossChecks, saDocuments, saFormats, saMockChecks, saValidators } from './rules.js';
import { saudiTemplate } from './template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** Starting text for the Personal Data Protection Law (PDPL). Have it reviewed by counsel before go-live. */
export function saudiNotice(company: string, contactEmail?: string) {
  return `${company} ("we") collects the information in this registration to evaluate you as a supplier, set you up in our purchasing and payment systems, pay you, and meet our legal, Zakat and tax obligations. This notice is provided under the Personal Data Protection Law (PDPL) of the Kingdom of Saudi Arabia.

What we collect: company and contact details, commercial registration, VAT, Zakat, GOSI and Saudization information, the names, nationalities and shareholdings of owners, bank account details, financial and risk information, and the documents you upload.

Why and on what basis: to assess and register you as a supplier and to pay you (performing a contract with you), and to meet our obligations under Saudi law, including sanctions and anti-money-laundering checks.

How it is checked and shared: registrations may be verified with government sources and verification service providers, and names are screened against sanctions lists. Uploaded documents may be read automatically to pre-fill the form. Approved supplier records are sent to our ERP / accounting system. Where a service provider processes data outside the Kingdom, we do so only as the PDPL and its regulations permit. We do not sell your data.

How long we keep it: while you are an active supplier and afterwards for as long as Zakat, tax and commercial record-keeping rules require. Registrations that are rejected or not completed are deleted after a set period.

Your rights: you can be informed about how your data is used, access and obtain a copy of it, correct it (request a change in this portal), and ask us to delete it where it is no longer needed. Some records of approved suppliers must be kept by law even after a deletion request. You can also complain to the Saudi Data & AI Authority (SDAIA).${contactEmail ? `\n\nContact for data protection questions: ${contactEmail}` : ''}`;
}

export function saudiNoticeAr(company: string, contactEmail?: string) {
  return `تجمع ${company} («نحن») المعلومات الواردة في هذا التسجيل لتقييمكم كمورد، وتسجيلكم في أنظمة المشتريات والمدفوعات لدينا، والسداد لكم، والوفاء بالتزاماتنا النظامية والزكوية والضريبية. ويُقدَّم هذا الإشعار وفقاً لنظام حماية البيانات الشخصية في المملكة العربية السعودية.

ما نجمعه: بيانات الشركة وجهات الاتصال، والسجل التجاري، ومعلومات ضريبة القيمة المضافة والزكاة والتأمينات الاجتماعية والسعودة، وأسماء الملاك وجنسياتهم ونسب ملكيتهم، والبيانات المصرفية، والمعلومات المالية ومعلومات المخاطر، والمستندات التي ترفعونها.

الغرض والأساس النظامي: تقييمكم وتسجيلكم كمورد والسداد لكم (تنفيذاً لعقد معكم)، والوفاء بالتزاماتنا بموجب الأنظمة السعودية، بما في ذلك فحص قوائم العقوبات ومكافحة غسل الأموال.

التحقق والمشاركة: قد يتم التحقق من التسجيلات لدى الجهات الحكومية ومقدمي خدمات التحقق، وتُفحص الأسماء مقابل قوائم العقوبات. وقد تُقرأ المستندات المرفوعة آلياً لتعبئة النموذج مسبقاً. وتُرسل بيانات الموردين المعتمدين إلى نظام تخطيط الموارد / النظام المحاسبي لدينا. وإذا عالج أحد مقدمي الخدمات البيانات خارج المملكة، فلا يتم ذلك إلا وفق ما يسمح به النظام ولوائحه. ولا نبيع بياناتكم.

مدة الاحتفاظ: طوال فترة كونكم مورداً نشطاً، وبعدها للمدة التي تتطلبها أنظمة الزكاة والضريبة وحفظ السجلات التجارية. وتُحذف التسجيلات المرفوضة أو غير المكتملة بعد مدة محددة.

حقوقكم: يحق لكم العلم بكيفية استخدام بياناتكم، والاطلاع عليها والحصول على نسخة منها، وتصحيحها (بتقديم طلب تعديل في هذه البوابة)، وطلب حذفها متى انتفت الحاجة إليها. ويلزم النظام الاحتفاظ ببعض سجلات الموردين المعتمدين حتى بعد طلب الحذف. كما يحق لكم تقديم شكوى إلى الهيئة السعودية للبيانات والذكاء الاصطناعي (سدايا).${contactEmail ? `\n\nللاستفسارات المتعلقة بحماية البيانات: ${contactEmail}` : ''}`;
}

export const saudiPack: CountryPack = {
  code: 'SA',
  name: 'Saudi Arabia',
  extends: 'GCC',
  homeCountry: true,
  registerIds: [{ label: 'CR number', field: 'tax.crNumber' }, { label: 'VAT number', field: 'tax.vatNumber' }],
  currency: 'SAR',
  locale: 'en-GB',
  mobile: { dialCode: '966', nationalDigits: 9, pattern: /^5\d{8}$/, example: '05x xxx xxxx' },
  timeZone: 'Asia/Riyadh',
  timeZoneLabel: 'AST',
  coreFields: ['basic.nameArabic', 'tax.crNumber', 'tax.vatRegistered', 'tax.hasTrc'],

  validators: saValidators,
  formats: saFormats,
  crossChecks: saCrossChecks,

  checks: saChecks,
  checkProvider: () => saMockChecks,
  checksTitle: 'CR (Wathq) / VAT (ZATCA) checks',

  documents: saDocuments,

  template: saudiTemplate,
  privacy: { law: 'Personal Data Protection Law (PDPL)', lawShort: 'PDPL', defaultNotice: saudiNotice, defaultNoticeAr: saudiNoticeAr },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.vatNumber),
    domesticBlock: (p: Profile) => ({
      key: 'SAUDI_LOCALIZATION',
      value: {
        CR_NUMBER: s(p.tax?.crNumber), VAT_NUMBER: s(p.tax?.vatNumber), VENDOR_NAME_AR: s(p.basic?.nameArabic),
        NATIONAL_ADDRESS_ADDITIONAL_NO: s(p.basic?.additionalNumber), CHAMBER_NO: s(p.basic?.chamberNumber),
        NITAQAT_BAND: s(p.localContent?.nitaqatBand), IKTVA_SCORE: s(p.localContent?.iktvaScore), SME_FLAG: s(p.basic?.isSme) === 'Yes' ? 'Y' : 'N',
      },
    }),
    // Payments to non-residents attract Saudi withholding tax; treaty relief needs a TRC.
    foreignBlock: (p: Profile) => ({ key: 'FOREIGN_TAX', value: { TIN: s(p.tax?.foreignTin), TRC_HELD: s(p.tax?.hasTrc), SAUDI_PE: s(p.tax?.hasSaudiPe) } }),
  },
};
