/**
 * Arabic versions of the supplier help topics (shown when a supplier uses the portal in Arabic).
 * The text lives in articles.ar.json (edited through the translation spreadsheet: npm run i18n:export / i18n:import).
 * Only text is translated — ids, screens, related links and audiences come from articles.ts.
 * A topic without an Arabic version is shown in English.
 */
import DATA from './articles.ar.json';

export const ARTICLES_AR: Record<string, { title: string; summary: string; body: string; keywords?: string }> = DATA;
