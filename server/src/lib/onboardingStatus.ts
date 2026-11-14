/** Onboarding statuses in which the form can still be filled in (by the supplier, or a buyer on their behalf). Shared everywhere — no local copies. */
export const EDITABLE_STATUSES = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'] as const;
export const isEditableStatus = (status: string) => (EDITABLE_STATUSES as readonly string[]).includes(status);
/** Document types currently on file (counted by the checklist). */
export const activeTypes = (docs: { status: string; docType: string }[]) => docs.filter((d) => d.status === 'ACTIVE').map((d) => d.docType);
