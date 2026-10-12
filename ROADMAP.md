# VendorGate roadmap

Planned work that has been discussed but not built yet.

## Help

- **AI "Ask a question" box in the F1 help panel.** Above the search results, a user types a question in their own words ("why can't I approve this vendor?") and gets an answer drawn only from the help articles, with links to the topics used. Uses the existing AI connection (`AI_PROVIDER`), switchable per workspace, and counted against the plan. The help articles in `web/src/help/articles.ts` are already the source it would answer from.
- Per-workspace help additions: let a workspace add its own topics (for example its approval policy) alongside the built-in ones.

## Email

- Per-workspace sender name and reply-to address, and daily send limits per workspace shown in the console.
- Bounce and complaint tracking (Resend webhooks), so bad addresses are flagged on the vendor.
- Custom sending domain per workspace (white-label), via Resend's Domains API.

## Platform console

- "Require 2FA" switch per workspace from the console.
- Billing and invoices for paid plans.

## Supplier collaboration — next phases
Phase 1 (purchase orders and acceptance, Oracle EBS first) is live.
- **Phase 2 — Shipping:** advance shipping notices against accepted lines (required per buying group), partial shipments, receipt matching from the ERP.
- **Phase 3 — Invoicing:** suppliers raise invoices from POs/ASNs; tolerance checks; country rules as plug-ins, starting with India e-invoicing (IRN/QR validation, GSTIN match).
- **Phase 4 — Payments:** payment status and remittance advice from the ERP; more ERP connectors (SAP S/4HANA, Dynamics 365).
