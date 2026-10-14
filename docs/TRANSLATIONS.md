# Translations (Arabic)

Suppliers of Gulf workspaces can use the portal in Arabic. Staff screens and staff emails stay in English.

## Where the Arabic lives

| What | File | Key |
|---|---|---|
| Portal screen text | `web/src/i18n/en.json` + `ar.json` | a name such as `portal.submit` |
| Messages the server sends to suppliers (errors, checklist, check results) | `server/src/i18n/messages.ar.json` | the English text; `{label}`-style placeholders match any value |
| Built-in Gulf onboarding form (labels, help, options, documents, guide, review levels) | `server/src/i18n/config.ar.json` | the English text |
| Supplier emails and SMS | `server/src/i18n/emails.json` | email name, English and Arabic subject/body |
| Supplier help topics | `web/src/help/articles.ar.json` | topic id (English in `articles.ts`) |
| Privacy notices | country packs (`defaultNoticeAr`) | — |

A workspace's own fields are translated by the workspace in the Configuration editor (the *Arabic* boxes); those
win over the built-in wording. Stored answers stay in English (the Arabic is only how a choice is shown), so
validation, reports and the ERP export are the same in both languages.

## Working with a translator

```
npm run i18n:export                  # translations-ar.csv: every supplier-facing text with its Arabic
npm run i18n:export -- --missing     # only rows that need attention
npm run i18n:import -- translations-ar.csv
npm run i18n:check                   # missing Arabic or {placeholder} mistakes (exits 1; also a server test)
```

The CSV has the columns **Area, Key, English, Arabic, Status**. It opens in Excel with Arabic intact; when saving
from Excel choose **CSV UTF-8**. Only the Arabic column is read back:
- a blank Arabic cell leaves the current Arabic alone;
- a row whose `{placeholders}` don't match the English is skipped and reported (e.g. `{buyer}` must stay `{buyer}`);
- rows with an unknown Area/Key are reported and ignored.

Review the change with `git diff`, then commit and push as usual.

## Adding new text

- **Screens:** add the key to both `en.json` and `ar.json` and use `t('key')`. Plurals use suffixes
  `_zero _one _two _few _many _other` (Arabic uses all six).
- **Server messages:** add the English sentence and its Arabic to `messages.ar.json`; until then the supplier sees English.
- **Template wording:** add the Arabic to `config.ar.json` (the server test fails until you do).
- **Emails:** add the email to `emails.json` with `en` and `ar`, and send it with `mailSupplier(lang, …, key, vars)`.

## Dates and documents
Dates in the Arabic portal show the Gregorian date with the Umm al-Qura Hijri date beside it. Date inputs stay
Gregorian. When the AI reads a document, Arabic names are kept exactly as printed, Arabic-Indic digits become 0-9 and
Hijri-only dates are converted to Gregorian.
