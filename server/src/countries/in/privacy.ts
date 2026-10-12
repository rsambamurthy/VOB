/** India: Digital Personal Data Protection Act, 2023 (DPDP). */
/** Starting text. Each workspace should have it reviewed by their own counsel before go-live. */
export function indiaNotice(company: string, contactEmail?: string) {
  return `${company} ("we") collects the information in this registration to evaluate you as a supplier, set you up in our purchasing and payment systems, pay you, and meet our tax and legal obligations.

What we collect: business and contact details, tax registrations (PAN, GSTIN, TAN, CIN, MSME), bank account details, financial and risk information, and the documents you upload.

How it is checked and shared: tax and bank details may be verified with government databases and verification service providers (including a ₹1 test transfer to confirm your bank account). Uploaded documents may be read automatically to pre-fill the form. Approved supplier records are sent to our ERP / accounting system. We do not sell your data.

How long we keep it: while you are an active supplier and afterwards for as long as tax and accounting laws require. Registrations that are rejected or not completed are deleted after a set period.

Your rights: you can see and download the data we hold about you, correct it (request a change in this portal), withdraw consent and ask us to delete it, and raise a grievance. Some records of approved suppliers must be kept by law even after a deletion request.${contactEmail ? `\n\nContact / grievance officer: ${contactEmail}` : ''}`;
}
