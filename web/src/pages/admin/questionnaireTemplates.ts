/** Starting points for Administration → Questionnaires. Edit freely after picking one. */
type Opt = { label: string; labelAr?: string; points: number; knockout?: boolean };
export interface QDraft { id: string; text: string; textAr?: string; help?: string; helpAr?: string; type: 'yesno' | 'choice' | 'multi' | 'text' | 'number' | 'file'; required: boolean; options?: Opt[]; points?: number; showIf?: { questionId: string; equals: string } }
export interface Template { key: string; title: string; titleAr: string; description: string; questions: QDraft[] }

const yes = (points = 10, knockoutOnNo = false): Opt[] => [{ label: 'Yes', labelAr: 'نعم', points }, { label: 'No', labelAr: 'لا', points: 0, ...(knockoutOnNo ? { knockout: true } : {}) }];

export const TEMPLATES: Template[] = [
  {
    key: 'esg', title: 'ESG self-assessment', titleAr: 'تقييم ذاتي للاستدامة والحوكمة',
    description: 'How your business looks after the environment, its people and its governance.',
    questions: [
      { id: 'envPolicy', text: 'Do you have a written environmental policy?', textAr: 'هل لديكم سياسة بيئية مكتوبة؟', type: 'yesno', required: true, options: yes() },
      { id: 'envPolicyFile', text: 'Upload your environmental policy', textAr: 'ارفعوا سياستكم البيئية', type: 'file', required: true, points: 5, showIf: { questionId: 'envPolicy', equals: 'Yes' } },
      { id: 'iso14001', text: 'Are you ISO 14001 certified?', textAr: 'هل أنتم حاصلون على شهادة ISO 14001؟', type: 'yesno', required: true, options: yes(10) },
      { id: 'childLabour', text: 'Do you employ anyone under the legal working age?', textAr: 'هل توظفون أي شخص دون السن القانونية للعمل؟', type: 'yesno', required: true, options: [{ label: 'Yes', labelAr: 'نعم', points: 0, knockout: true }, { label: 'No', labelAr: 'لا', points: 10 }] },
      { id: 'minWage', text: 'Do all your workers receive at least the legal minimum wage?', textAr: 'هل يتقاضى جميع العاملين لديكم الحد الأدنى للأجور على الأقل؟', type: 'yesno', required: true, options: yes(10, true) },
      { id: 'safety', text: 'How often do you run health and safety training?', textAr: 'كم مرة تنظمون تدريباً على الصحة والسلامة؟', type: 'choice', required: true, options: [{ label: 'At least yearly', labelAr: 'سنوياً على الأقل', points: 10 }, { label: 'Occasionally', labelAr: 'أحياناً', points: 5 }, { label: 'Never', labelAr: 'أبداً', points: 0 }] },
      { id: 'esgNotes', text: 'Anything else about your sustainability work?', textAr: 'هل هناك ما تودون إضافته عن جهودكم في الاستدامة؟', type: 'text', required: false },
    ],
  },
  {
    key: 'infosec', title: 'Information security', titleAr: 'أمن المعلومات',
    description: 'For suppliers who handle our data or connect to our systems.',
    questions: [
      { id: 'iso27001', text: 'Are you ISO 27001 or SOC 2 certified?', textAr: 'هل أنتم حاصلون على شهادة ISO 27001 أو SOC 2؟', type: 'choice', required: true, options: [{ label: 'ISO 27001', points: 20 }, { label: 'SOC 2', points: 20 }, { label: 'Both', labelAr: 'كلاهما', points: 20 }, { label: 'Neither', labelAr: 'لا هذا ولا ذاك', points: 0 }] },
      { id: 'certFile', text: 'Upload the certificate or report', textAr: 'ارفعوا الشهادة أو التقرير', type: 'file', required: false, points: 5 },
      { id: 'mfa', text: 'Do your staff use two-factor sign-in for email and business systems?', textAr: 'هل يستخدم موظفوكم التحقق الثنائي للبريد والأنظمة؟', type: 'yesno', required: true, options: yes(10) },
      { id: 'encryption', text: 'Is our data encrypted when stored and when sent?', textAr: 'هل تُشفَّر بياناتنا عند تخزينها وعند إرسالها؟', type: 'yesno', required: true, options: yes(10, true) },
      { id: 'breach', text: 'Have you had a data breach in the last 3 years?', textAr: 'هل تعرضتم لاختراق للبيانات خلال السنوات الثلاث الماضية؟', type: 'yesno', required: true, options: [{ label: 'Yes', labelAr: 'نعم', points: 0 }, { label: 'No', labelAr: 'لا', points: 10 }] },
      { id: 'breachDetails', text: 'What happened and what did you change?', textAr: 'ماذا حدث وما الذي غيّرتموه؟', type: 'text', required: true, showIf: { questionId: 'breach', equals: 'Yes' } },
    ],
  },
  {
    key: 'abc', title: 'Anti-bribery and conflicts of interest', titleAr: 'مكافحة الرشوة وتضارب المصالح',
    description: 'Required of every supplier.',
    questions: [
      { id: 'abcPolicy', text: 'Do you have an anti-bribery and corruption policy?', textAr: 'هل لديكم سياسة لمكافحة الرشوة والفساد؟', type: 'yesno', required: true, options: yes(10) },
      { id: 'pep', text: 'Is any owner or director a government official or related to one?', textAr: 'هل أي من المالكين أو المديرين مسؤول حكومي أو قريب لمسؤول حكومي؟', type: 'yesno', required: true, options: [{ label: 'Yes', labelAr: 'نعم', points: 0 }, { label: 'No', labelAr: 'لا', points: 10 }] },
      { id: 'pepDetails', text: 'Who, and what is their role?', textAr: 'من هو، وما دوره؟', type: 'text', required: true, showIf: { questionId: 'pep', equals: 'Yes' } },
      { id: 'related', text: 'Is anyone in your company related to one of our employees?', textAr: 'هل يرتبط أي شخص في شركتكم بقرابة مع أحد موظفينا؟', type: 'yesno', required: true, options: [{ label: 'Yes', labelAr: 'نعم', points: 0 }, { label: 'No', labelAr: 'لا', points: 10 }] },
      { id: 'sanctions', text: 'Has your company or any owner been sanctioned, debarred or convicted of fraud or bribery?', textAr: 'هل خضعت شركتكم أو أي من مالكيها لعقوبات أو حظر أو إدانة بالاحتيال أو الرشوة؟', type: 'yesno', required: true, options: [{ label: 'Yes', labelAr: 'نعم', points: 0, knockout: true }, { label: 'No', labelAr: 'لا', points: 10 }] },
    ],
  },
  {
    key: 'quality', title: 'Quality management', titleAr: 'إدارة الجودة',
    description: 'For suppliers of goods and contracting work.',
    questions: [
      { id: 'iso9001', text: 'Are you ISO 9001 certified?', textAr: 'هل أنتم حاصلون على شهادة ISO 9001؟', type: 'yesno', required: true, options: yes(15) },
      { id: 'iso9001File', text: 'Upload your ISO 9001 certificate', textAr: 'ارفعوا شهادة ISO 9001', type: 'file', required: true, points: 5, showIf: { questionId: 'iso9001', equals: 'Yes' } },
      { id: 'inspection', text: 'How do you check goods before dispatch?', textAr: 'كيف تفحصون البضائع قبل الشحن؟', type: 'multi', required: true, options: [{ label: 'Incoming material inspection', labelAr: 'فحص المواد الواردة', points: 5 }, { label: 'In-process checks', labelAr: 'فحوصات أثناء التصنيع', points: 5 }, { label: 'Final inspection', labelAr: 'الفحص النهائي', points: 5 }, { label: 'None', labelAr: 'لا شيء', points: 0 }] },
      { id: 'rejectRate', text: 'Customer rejection rate last year (%)', textAr: 'نسبة رفض العملاء العام الماضي (%)', type: 'number', required: false },
    ],
  },
];
