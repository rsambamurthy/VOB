# VendorGate roadmap

Planned work that has been discussed but not built yet.

## Help

- Done: AI "Ask" in F1 help (answers only from the topics the person can see, per-workspace switch, daily limit by plan) and per-workspace help topics for staff and/or suppliers.
- (Original note) **AI "Ask a question" box in the F1 help panel.** Above the search results, a user types a question in their own words ("why can't I approve this vendor?") and gets an answer drawn only from the help articles, with links to the topics used. Uses the existing AI connection (`AI_PROVIDER`), switchable per workspace, and counted against the plan. The help articles in `web/src/help/articles.ts` are already the source it would answer from.
- Per-workspace help additions: let a workspace add its own topics (for example its approval policy) alongside the built-in ones.

## Email
- Done: per-workspace sender name and reply-to; bounce and complaint tracking (Resend webhooks) with suppression and a vendor flag; own sending domain via Resend's Domains API; staff can change a supplier's contact email.

## Platform console

- Done: "Require 2FA" switch per workspace from the console (enforced; the workspace admin can't switch it off).
- Done: billing — GST tax invoices (CGST+SGST / IGST / zero-rated export in USD), FY invoice numbers, PDF, Razorpay payment links + webhook, upgrade from trial, automatic renewals and overdue reminders, manual payments and cancellations in the console.

## Supplier collaboration
- Done — Phase 1: purchase orders and acceptance (Oracle EBS first).
- Done — Phase 2, shipping: shipment notices (ASN) against accepted goods lines with partial shipments and tolerance, "ASN required" per buying group, ERP messages (Oracle receiving interface shape / signed events / CSV), receipts via `POST /api/v1/receipts` matched to notices.
- Done — Phase 3, invoicing: suppliers raise invoices from an order or shipment with a PDF; matching on quantity (ordered, received, already billed), price tolerance, arithmetic, currency and duplicates; India e-invoice IRN and signed-QR checks; staff review queue (approve / reject); approved invoices sent to the ERP (Oracle payables interface shape).
- Done — Phase 4, payments: `POST /api/v1/payments` with invoice allocations and tax withheld, paid / partly paid status, payment advice emails, supplier and staff payment lists. SAP S/4HANA (API_BUSINESS_PARTNER) and Dynamics 365 F&O (VendorsV2 + bank accounts) supplier connectors; their order messages go to a middleware URL (CPI / Logic Apps).
- Next: verify the e-invoice QR signature against the IRP public keys; credit notes; SAP / Dynamics order messages directly to the ERP APIs (PO confirmation, inbound delivery, supplier invoice) instead of middleware.

## AI
- Done: **Ask VendorGate** — staff ask about their suppliers in plain words (top-bar box and an Ask page). The AI only turns the question into one of six fixed, read-only searches (suppliers, expiring documents, pending approvals, change requests, purchase orders, invoices); VendorGate runs it within the user's permissions. The AI never sees supplier data; masked fields are never returned; every question is audited; per-workspace switch and daily limit by plan; Excel download.
- Next: conversational onboarding for suppliers (workspace switch: form or AI-guided), then AI pre-review of submissions and bank-change risk scoring.

## Country packs
- **Phase 0 (done):** India moved into its own pack; workspaces have a home country; checks, formats, documents, template, privacy notice, ERP mapping and formatting come from packs. See docs/COUNTRY_PACKS.md.
- **Phase 1 (done):** shared Gulf pack + Saudi Arabia: Saudi template, CR/VAT checks (test mode), UBO/PEP, sanctions screening, automatic hold on lapsed Zakat/GOSI/Nitaqat/CR, working-day deadlines, SAR/AST, PDPL notice, country on sign-up, demo workspace "najd".
- **Phase 2 (done):** Arabic supplier portal for all six Gulf countries — right-to-left screens, the Gulf form, documents, guide, help, privacy notice, errors and every supplier email/SMS in Arabic; Hijri dates beside Gregorian; Arabic document reading (Arabic names kept exact, Arabic-Indic digits, Hijri dates). Each supplier picks a language (workspace default in Settings); staff screens stay English. Workspaces add Arabic for their own fields in the Configuration editor; built-in wording is maintained in translation files with a spreadsheet export/import (docs/TRANSLATIONS.md).
- Next (to decide): an in-console Translations page so platform admins can edit the built-in Arabic without a release.
- **Phase 3 (built, needs credentials):** OpenSanctions screening of supplier and owners, Wathq CR, Gulf IBAN/account check, registry connectors and a KYC aggregator for every other check — see docs/VERIFICATION.md.
- **Phase 4:** UAE, Bahrain, Qatar, Kuwait and Oman packs (done) on the shared Gulf template — all six GCC countries covered. **Phase 5:** in-region hosting when a customer requires it.
