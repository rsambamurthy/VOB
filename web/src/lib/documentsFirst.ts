/**
 * Automatic data entry ("documents first") on the onboarding form — shared by the supplier portal and a buyer
 * filling in for the supplier (VendorDetail). Both pages use these, so the behaviour can't drift apart.
 */
import { useEffect } from 'react';
import type { DocRequirement, Extraction, Profile, DocumentRow } from './types';
import type { FieldSource } from '../components/DynamicSection';

export type DataEntryMode = 'manual' | 'assisted' | 'automatic';

/** Documents first in automatic mode; otherwise after the form tabs. */
export function formTabs<T extends { key: string; label: string }>(sectionTabs: T[], docTab: T, automatic: boolean): T[] {
  return automatic ? [docTab, ...sectionTabs] : [...sectionTabs, docTab];
}

/** While any document is still being read, refresh every few seconds so the form fills in as it happens. */
export function useRefreshWhileReading(extractions: Extraction[] | undefined, active: boolean, refresh: () => unknown, everyMs = 3000) {
  const reading = active && !!extractions?.some((e) => e.status === 'PENDING');
  useEffect(() => { if (!reading) return; const iv = setInterval(refresh, everyMs); return () => clearInterval(iv); }, [reading, refresh, everyMs]);
  return reading;
}

/** Same value, ignoring case, spaces and punctuation (masked values compare as masked). */
export const sameValue = (a: unknown, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9•؀-ۿ]/g, '');
  return n(String(a ?? '')) === n(b);
};

/** Label of the document a value was read from ("GST Registration Certificate"). */
export function docLabelFor(documentId: string, documents: Pick<DocumentRow, 'id' | 'docType'>[], requirements: DocRequirement[], extractions: Extraction[] = []) {
  const d = documents.find((x) => x.id === documentId);
  if (!d) return '';
  return (requirements.find((r) => r.type === d.docType)?.label ?? extractions.find((x) => x.documentId === documentId)?.docLabel ?? d.docType).replace(/ \(.*\)$/, '');
}

/**
 * Per field: filled in from which document, or read but waiting to be confirmed (bank details, tax numbers,
 * low confidence, or different from what was typed) with a "Use this" action.
 */
export function fieldSources(opts: { extractions: Extraction[]; documents: Pick<DocumentRow, 'id' | 'docType'>[]; requirements: DocRequirement[]; profile: Profile; onUse: (extractionId: string, fieldId: string) => void }) {
  const { extractions, documents, requirements, profile, onUse } = opts;
  const sources: Record<string, FieldSource> = {};
  for (const e of extractions.filter((x) => x.status === 'DONE' && documents.some((d) => d.id === x.documentId))) {
    const doc = docLabelFor(e.documentId, documents, requirements, extractions);
    for (const sg of e.suggestions) {
      const [sec, key] = sg.fieldId.split('.');
      const now = profile[sec]?.[key];
      if (sources[sg.fieldId]?.kind === 'filled') continue;
      if (sg.autoFilled && sameValue(now, sg.value)) sources[sg.fieldId] = { doc, kind: 'filled' };
      else if (!sameValue(now, sg.value) && !sources[sg.fieldId]) sources[sg.fieldId] = { doc, kind: 'check', value: sg.value, onUse: () => onUse(e.id, sg.fieldId) };
    }
  }
  const all = Object.values(sources);
  return { sources, filledCount: all.filter((x) => x.kind === 'filled').length, toConfirm: all.filter((x) => x.kind === 'check').length };
}
