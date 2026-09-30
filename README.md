# VendorGate: Vendor Onboarding Prototype

This is a working prototype of a vendor onboarding and approval system. It follows the flow in the Integrata "Vendor Onboarding: A Walkthrough" video and fills in the gaps the video left open.

**Stack:** React + TypeScript (Vite) · Node + Express + TypeScript · PostgreSQL via Drizzle ORM

## What it does

| Step | Who | What happens |
|---|---|---|
| 1 | Buyer admin | Creates the vendor (name, type, contact) and sends an invite email |
| 2 | Vendor | Opens the invite link and signs in with an **email OTP** (no password) |
| 3 | Vendor | Fills in **Basic Info, Bank, Tax and Financial Risk** tabs and uploads **Documents**. A live **Required Fields checklist** blocks submission until everything is valid |
| 4 | Vendor | Runs **online checks** on GSTIN, PAN, CIN and bank account (penny-drop). These are *mocked* in the prototype |
| 5 | Reviewers | **Tax → Finance & Risk → Master Data**, in order. Each reviewer can **Approve**, **Send back** (with remarks the vendor sees) or **Reject** |
| 6 | Vendor | When sent back, fixes the form and resubmits. The review starts a new cycle and history is kept |
| 7 | Master data | An approved vendor can be exported as an **Oracle EBS supplier payload** (the same shape as `ERPVendorsData`) |

**Beyond the video:** send-back and rejection paths, audit history, a GSTIN checksum check and a GSTIN↔PAN cross-check, IBAN mod-97, IFSC/SWIFT/TAN/CIN/Udyam formats, conditional fields (for example Indian vs foreign vendor), duplicate-vendor check, and guards so two reviewers can't action the same step.

## Run it locally

Prerequisites: Node 20+ and Docker (or any Postgres 14+).

```bash
npm install
npm run db:up                      # starts Postgres in Docker (or point server/.env at your own)
cp server/.env.example server/.env
npm run db:setup                   # creates tables + loads demo data
npm run dev                        # API on :4000, web on http://localhost:5173
```

### Demo walkthrough

1. Open http://localhost:5173 and pick **Anita Rao (Vendor Admin)**.
2. **+ New vendor** creates a vendor and sends the invite.
3. **Mailbox** (sidebar) opens the invitation, then **Open vendor portal**. It opens in a new tab so the vendor and staff sessions stay separate. The OTP is shown on screen in prototype mode.
4. Fill in the tabs and upload documents (any PDF/JPG/PNG), then **Submit for review**.
5. **Switch user** to **Suresh Iyer (Tax)** and open **My approvals** to approve. Then do the same as **Meera Nair (Finance)** and **Vikram Shah (Master Data)**.
6. On the approved vendor, **ERP export** shows the Oracle payload.

The seeded data covers each stage: one approved vendor (VND-00001), one waiting for Finance (VND-00002), one invited (VND-00003) and one foreign vendor in progress (VND-00004).

**Test GSTIN tip:** a valid test GSTIN is `27` + a valid PAN + `1Z` + a check character. The form tells you when the checksum is wrong. `27AAPFU0939F1ZV` with PAN `AAPFU0939F` works.

## Tests

```bash
npm test -w server        # validator unit tests (GSTIN checksum, PAN, IFSC, IBAN…)
npm run smoke             # full API flow: invite → OTP → fill → submit → send back → resubmit → 3 approvals → ERP export
                          # (needs `npm run dev` running)
```

## Where to change things

| To change… | Edit |
|---|---|
| Fields, tabs, dropdown values, required rules, show/hide conditions | `server/src/config/formSchema.ts`. The UI and validation both read from this file, so there's no frontend change |
| Required documents and when they apply | `documentRequirements` in the same file |
| Approval levels and their order (optionally per vendor type) | `server/src/config/workflow.ts` |
| Format checks | `server/src/lib/validators.ts` |
| Online verification (GSTN, NSDL PAN, penny-drop, MCA) | `server/src/lib/verification.ts` (currently mocked) |
| ERP field mapping | `server/src/lib/erpMapper.ts` |
| Product name | `web/src/brand.ts` |

## Production gaps (deliberately stubbed)

| Area | Prototype | Replace with |
|---|---|---|
| Staff login | Pick a user, no password | SSO (Azure AD / Google) or password + MFA |
| Email | Stored in `email_outbox` and shown in Mailbox | SES / SendGrid / SMTP in `lib/mailer.ts`, then set `DEV_SHOW_OTP=false` |
| Verification | Deterministic mock | A GSP / KYC provider (e.g. Karza, Signzy, Surepass) or direct GSTN/NSDL APIs |
| File storage | Local `uploads/` folder | S3 / Azure Blob, with virus scanning |
| AI document extraction | Not included | OCR / LLM extraction to pre-fill fields from GST and PAN certificates |
| ERP push | JSON export | Oracle integration (REST/SOAP) or a file drop |
| Sensitive data | Plain columns | Encrypt bank account / PAN at rest; mask by role |

## Deploy

`Dockerfile` builds a single container that serves the API and the web app on port 4000. Set `DATABASE_URL`, `JWT_SECRET` and `APP_BASE_URL`, then run `npm run db:push -w server` once against the database. This works on Railway, Render, Fly or any container host.

## Project layout

```
server/
  src/config/     formSchema.ts (fields), workflow.ts (approval levels)
  src/db/         schema.ts (Drizzle tables), seed.ts
  src/lib/        validators, profileEngine (checklist), workflowEngine, verification (mock), erpMapper, auth, mailer
  src/routes/     auth (staff + vendor OTP), staff, vendorPortal, documents, meta
  scripts/smoke.ts
web/
  src/pages/      StaffLogin, VendorList, VendorDetail, Mailbox, VendorLogin, VendorPortal
  src/components/ DynamicSection (renders forms from config), Checklist, DocumentsPanel, Timeline
```
