import { LANG_NAMES, setLang, t, useLang, type Lang } from './index';

/** "العربية" / "English" toggle, shown only when the buyer offers more than one language. */
export function LangSwitch({ available, onChange }: { available?: Lang[]; onChange?: (l: Lang) => unknown }) {
  const lang = useLang();
  if (!available || available.length < 2) return null;
  const other: Lang = lang === 'ar' ? 'en' : 'ar';
  return (
    <button type="button" className="lang-switch" lang={other} title={t('lang.switchTo')} onClick={async () => { await onChange?.(other); setLang(other, { remember: true }); }}>
      {LANG_NAMES[other]}
    </button>
  );
}
