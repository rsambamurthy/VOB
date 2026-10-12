# VendorGate — Vendor Onboarding Platform

A multi-tenant SaaS for supplier onboarding: buyer companies invite vendors, and vendors complete a self-service profile (KYC, bank, tax, risk, documents) that goes through a configurable multi-level approval flow before export to the ERP.

**Stack:** React + TypeScript (Vite) · Node + Express + TypeScript · PostgreSQL + Drizzle ORM · Vitest

## Build status

| Phase | Scope | Status |
|---|---|---|
| 0. Prototype | Invite → OTP portal → profile + documents → 3-level approval → Oracle-shaped export | ✅ |
| **1. Platform foundation** | Multi-tenant workspaces, staff accounts (password, invite, reset, lockout), TOTP 2FA + recovery codes, workspace-enforced 2FA, tenant-defined roles & permissions, cookie sessions, CSRF / rate limits / security headers, audit log, SQL migrations, automated tests | ✅ |
| **2. Admin configuration** | Per-workspace form fields, documents and approval flow edited in the UI, with draft → publish, version history, restore and live preview. Rule-based approval levels (e.g. extra level for import vendors, Finance only above ₹5 cr), per-level deadlines (SLAs) with overdue reminders and escalation, reassigning a step to a person, and out-of-office delegation | ✅ |
| **3. Integrations** | Postgres job queue with retries; branded HTML email (SMTP / SendGrid); SMS sign-in codes (MSG91 DLT / Twilio); S3 / R2 / Azure storage with content-type sniffing, script-PDF blocking and optional ClamAV; GSTIN / PAN / penny-drop / MCA checks (Surepass) with caching, limits, masking and name matching; Claude reading uploaded documents to suggest values and flag mismatches. All in **test mode** until keys are added | ✅ |
| **4. Vendor lifecycle** | Approved vendors request changes, which are re-approved by the levels the changed fields need (bank → Finance + MDM, with automatic penny-drop and a security email). Document renewals with expiry dates and 30 / 7 / 0-day reminders. Periodic re-verification with vendor confirmation. Block / unblock with ERP payment holds. "Needs attention" flags across the vendor list | ✅ |
| **5. Reports & ERP** | Dashboard with an onboarding funnel, turnaround, time per approval level, ageing and approver workload. Eight reports with Excel download. Automatic ERP push to Oracle EBS, a signed webhook or CSV (download or SFTP), with test mode, retries, a delivery log and the ERP vendor id stored on the vendor | ✅ |
| **6. Hardening** | PAN and bank numbers encrypted in the database, with key rotation. Staff see masked values and every "Reveal" is logged. DPDP: privacy notice and recorded consent, data export, erasure on request and by retention policy. Backups and restore. Browser tests, GitHub CI and a dependency audit. Railway deployment | ✅ |

## Quick start (Windows / macOS / Linux)

Prerequisites: **Node 20+** and **Docker Desktop** (running), or your own Postgres 14+.

```bash
npm install
npm run db:up                                   # Postgres in Docker on port 5433
copy server\.env.example server\.env            # macOS/Linux: cp server/.env.example server/.env
npm run db:setup                                # creates/updates tables; demo data only if empty
npm run dev                                     # web → http://localhost:5173, API → :4000
```

If `db:setup` fails right after `db:up`, wait about 10 seconds for Postgres to start and run it again.
`db:setup` is safe to run after every update: it applies new migrations and **never deletes data**. Demo workspaces are loaded only into an empty database. To deliberately wipe everything and reload the demo data, run `npm run db:reset -- --yes`.

### Demo sign-in

Every demo user's password is **`Demo@12345`**.

| Workspace ID | Email | Role |
|---|---|---|
| `acme` | admin@acme.test | Administrator (users, roles, workspace, audit) |
| `acme` | vendoradmin@acme.test | Vendor Admin (creates/invites vendors) |
| `acme` | tax@acme.test | Tax Accounts Manager (approval level 1) |
| `acme` | finance@acme.test | Finance Manager (approval level 2) |
| `acme` | mdm@acme.test | Master Data Manager (final level, ERP export) |
| `acme` | compliance@acme.test | Compliance Officer (extra level, import vendors only) |
| `globex` | admin@globex.test | Administrator of a *separate* company — can't see anything in `acme` |

**Things to try**

1. Sign in as `admin@acme.test` → **Users** → **Invite user** → open **Mailbox** (dev only) → open the invitation *in a private window* (it signs you in as the new user) and set a password.
2. **My account** → turn on two-factor authentication with any authenticator app, sign out and back in.
3. **Workspace** → change the brand colour / portal name; the vendor portal and emails pick it up. Tick **Require 2FA** to force every user to enrol.
4. **Vendors** → **New vendor** → Mailbox → *Open vendor portal* → complete the profile → approve as tax → finance → mdm.
5. Sign in to `globex` and confirm none of Acme's vendors or users are visible.
6. **Configuration** (admin):
   - **Form fields:** add a group and a field, and make a follow-up field appear only when the first answer is "Yes". **Preview form** shows it working.
   - **Documents:** add a document that is required only for certain answers, and tick **Track expiry**.
   - **Approval flow:** add a rule such as *Finance only when Annual Turnover is more than 50000000*, then use **Test the flow** on the right to see which levels a sample vendor goes through.
   - **Save draft → Publish**: the publish screen shows exactly what changed. **History** lets you preview or restore any earlier version.
7. Open **Kaveri Steel Traders** (waiting for Finance) → **Reassign** to a specific person. As that person, use **My account → Out of office** to hand your approvals to a colleague. They appear in the colleague's **My approvals**.

## Creating a customer workspace

```bash
npm run tenant:create -- --slug initech --name "Initech Ltd" --admin-name "Bill Lumbergh" --admin-email bill@initech.com
```

This creates the workspace with the default roles and prints (and emails) the first administrator's invitation link.

## Integrations (Phase 3)

Every integration starts in **test mode**: nothing leaves the server, and **Admin → Integrations** shows each one's status with a **How to go live** snippet. To switch one on, fill in its section of `server/.env` (see `.env.example`) and restart. The server refuses to start if you pick a provider without its keys.

| Integration | Test mode | Live options | Notes |
|---|---|---|---|
| **Email** | Recorded in the Mailbox | `smtp` (SES, M365, Google, Zoho…) or `sendgrid` | Branded HTML with the workspace colour, logo and a button. Every message is logged with its status (sent / failed + error). Retries with backoff. |
| **SMS** | Recorded in `sms_log` | `msg91` (India, DLT template) or `twilio` | Used for vendor sign-in codes. Each workspace chooses email, SMS (falling back to email) or both under Integrations. |
| **Storage** | Server disk | `s3` (AWS, Cloudflare R2, MinIO, Wasabi) or `azure` | Files are private; downloads go through a 60-second signed URL after the permission check. Each document remembers its driver, so switching drivers doesn't break old files. |
| **Upload safety** | Always on | `SCAN_PROVIDER=clamav` | The real file type is checked from its bytes (a renamed .exe is refused). PDFs with JavaScript or auto-run actions are refused. Optional ClamAV scan. Files are stored as `tenant/vendor/uuid.ext` with a SHA-256 hash. |
| **GSTIN / PAN / bank / MCA** | Instant fake answers | `surepass` | Identical checks are re-used for 24 hours, with a daily limit per vendor. Only masked identifiers are stored. The name on record is compared with the vendor's legal name (a match below 70% is flagged). Reviewers can re-run checks. Endpoint paths are configurable; **confirm them against your Surepass sandbox before going live**. |
| **AI document reading** | Echoes typed values | `anthropic` (Claude) | Reads GST, PAN, cheque, incorporation and Udyam documents. Values are format-checked (a misread GSTIN is dropped). The vendor chooses which suggestions to apply, and reviewers see where documents and answers differ. **Off until a workspace switches it on**, because documents are sent to the AI provider. |

Background work (email, SMS, AI reading, the 5-minute SLA sweep) runs on a **Postgres job queue** (pg-boss, schema `pgboss`), so there's no Redis to run. With `JOBS_ENABLED=false`, jobs run in-process instead.

Optional local services: `docker compose --profile scan up -d clamav` (virus scanning) and `docker compose --profile storage up -d minio` (S3-compatible storage to try `STORAGE_DRIVER=s3`).

**Test-mode tips:** a PAN whose 9th character is `0`, a GSTIN whose 13th character is `0`, or a bank account ending in `0` returns "not found", so you can see the failure path.

## Security, privacy and operations (Phase 6)

- **Encryption at rest:** PAN, TAN, foreign TIN, bank account number and IBAN are AES-256-GCM-encrypted inside the profile JSON. Old and new values in change requests, ERP payloads and AI extraction results are encrypted the same way. The code reads plain values, because the column types do the work (`lib/fieldCrypto.ts`).
  - `npm run db:setup` encrypts any older plain values.
  - Key rotation: see `DEPLOY.md`, and use `npm run db:reencrypt`.
- **Masking:** staff screens, the change-request queue and AI suggestions show `AAF••••••Q` and `••••••3456`. **Reveal** shows the full value and writes `SENSITIVE_REVEALED` to the audit log. Reports stay masked. The ERP push and ERP export send full values, behind the `vendors.export` permission.
- **DPDP:**
  - **Consent:** vendors must accept the workspace's privacy notice (Workspace → Privacy & data retention) before entering anything. Editing the notice creates a new version and asks every vendor to accept again. Consent version, time and IP are recorded.
  - **Data export:** vendors can **Download my data**. Staff with `vendors.export` can download a fuller export that includes the audit trail.
  - **Deletion requests:** a vendor can **withdraw consent and request deletion**. Administrators are emailed and can **Erase** or **Decline with a reason**. Approved suppliers must be blocked first, and registrations under review must be decided first.
  - **Erasure** anonymises the vendor: name, contacts, profile, documents, checks and emails are removed. Codes, status, dates and the audit trail (without personal details) are kept.
  - **Retention:** a daily job erases rejected registrations after 365 days and abandoned ones after 180 days. Both periods are configurable, and 0 turns them off.
- **Backups:**
  - `npm run db:backup` saves the database and uploaded files to `backups/<date>/`; add `-- --encrypt` to encrypt it.
  - `npm run db:restore -- <folder> --yes` restores a backup.
  - In production, set `BACKUP_SCHEDULE` for nightly encrypted dumps to storage, keeping `BACKUP_KEEP` (default 14).
- **Tests and CI:** `npm run test:e2e` runs the browser tests (Playwright) on their own server and database: onboarding with consent, masking and Reveal, dashboard, Excel, ERP preview and privacy settings. The first time, run `npx playwright install chromium`.
  - `.github/workflows/ci.yml` runs type checks, the 80 API tests, the build, the browser tests, `npm audit --omit=dev` and a Docker build on every push.
- **Dependencies:** production dependencies report 0 known vulnerabilities. React Router was upgraded to v7, and `uuid` is pinned to 11.1.1 for exceljs. The remaining `esbuild` advisory affects only the `drizzle-kit` developer tool.
- **Deployment:** see **[DEPLOY.md](DEPLOY.md)** (Railway: app + Postgres + `/data` volume).
  - `/api/health` checks the database.
  - The image runs as a non-root user and includes `pg_dump` 18.
  - `BOOTSTRAP_*` variables create the first workspace on an empty database.

## Reports and ERP (Phase 5)

**Dashboard** (needs `reports.view`; Administrator, Vendor Admin, Finance, Master Data Manager and Viewer have it by default). Filter by period and vendor type.
- **Tiles:** vendors approved, median days from invite to approval, open registrations, overdue approval steps, active and blocked vendors, and vendors needing attention.
- **Funnel:** vendors invited in the period, and how many started, submitted and were approved.
- **Turnaround:** median, average and slowest 10%, split into vendor time and review time.
- **Monthly:** vendors invited and approved per month.
- **Time per approval level:** with the share decided after the deadline and the number waiting now.
- **Ageing:** open registrations by stage and days waiting. Click a number to open the list.
- **Approver workload:** items waiting now, overdue, decided, and median response time.

**Reports** (preview on screen, **Download Excel** for the full list; every download is audited):
- Vendor register (PAN and bank account masked)
- Pending approvals
- Deadline (SLA) breaches
- Onboarding turnaround
- Change requests
- Expiring documents
- Blocked vendors
- ERP deliveries

To see the dashboard with realistic data, run `npm run db:demo-history`. It adds about 40 demo vendors with a year of history to the `acme` workspace. It only adds records, never changes or deletes any, and runs once.

**ERP push** is set up under Administration → **ERP integration**. Each workspace gets one connector:
- **Oracle E-Business Suite:** POSTs the `ERPVendorsData` payload (vendor → sites → banks, India localisation block) to a REST endpoint, with Basic auth and the operating unit (ORG_ID). `SYNC_ACTION` is CREATE until the ERP returns a vendor id, then UPDATE, with `VENDOR_ID` filled in.
- **Webhook:** POSTs a JSON event with the headers `X-VendorGate-Event`, `X-VendorGate-Delivery`, `X-VendorGate-Timestamp` and `X-VendorGate-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
  - Events: `vendor.approved`, `vendor.updated`, `vendor.blocked`, `vendor.unblocked`, `vendor.synced` and `ping`.
  - Reply with `{"vendorId":"…"}` and that id is stored on the vendor.
- **CSV:** one file per event (ACTION, vendor, address, tax, bank, hold flag columns). Files are kept for download or uploaded to an SFTP folder. There is also a one-click CSV of all approved vendors for a first bulk load.

How pushing works:
- **When it pushes:** on final approval, when an approved change takes effect (field changes only), and on block or unblock, so the ERP hold flag follows. "Push to ERP" on the vendor sends it on demand.
- **Delivery:** pushes run in the background with 4 retries and backoff. Each attempt is logged with the response, and a failed push emails the users who have `vendors.export`. Failed pushes can be retried from the vendor page or the delivery log.
- **Test mode** (on by default) records exactly what would be sent but sends nothing, and never stores a fake ERP id.
- **Security:**
  - Passwords and signing secrets are stored AES-GCM-encrypted and never sent back to the browser.
  - In production, ERP URLs must be https and public unless `ERP_ALLOW_PRIVATE_HOSTS=true`.
  - CSV cells that look like formulas are neutralised.

## Vendor lifecycle (Phase 4)

- **Change requests.** Once approved, the vendor portal shows the registered details read-only. **Request changes** unlocks the form; the vendor submits one request at a time, with an optional note, and sees an old → new summary first. The request goes only to the levels set under **Configuration → Approval flow → Changes after approval** (match a section with `bank.*`, a single field, or `documents`). If nothing matches, the default levels review it, or the last level if no default is set. The old values stay live until the final approval.
- **Staff-proposed changes.** Users with the `vendors.edit` permission (Master Data Manager and Administrator by default) can click **Propose change** on an approved vendor. They edit fields, attach replacement documents, and must give a reason and source (for example, "vendor emailed a new cheque on 3 Oct"). The proposal goes through the same routed approval. The proposer can never approve it: it is left out of their queue, and an approvals manager can reassign a step if they are the only person in that role. The demo has a second MDM, `mdm2@acme.test`. The vendor's contact is emailed when the change is proposed and again when it takes effect. They see it in the portal but cannot withdraw it; the proposer can.
- **Sensitive changes** (bank, GSTIN, PAN, legal name) are labelled for reviewers. A bank change also runs a penny-drop on the new account and emails the registered contact a security notice.
- **Documents.** Documents with an expiry (lower-TDS certificate, TRC, no-PE, financials) ask for a *valid until* date. A daily job (09:15 IST) reminds the vendor 30 days before, 7 days before and on the day, and copies approvers when a document has expired. After approval, renewals are uploaded as *pending* and go through a change request; once approved they replace the old file, which is kept as *replaced*.
- **Periodic re-check.** This runs every *N* months (Workspace → Vendor lifecycle; default 12; 0 turns it off). It re-runs the GSTIN, PAN and bank checks and asks the vendor to confirm their details. Problems are flagged to approvers. Staff can also click **Run re-check**.
- **Block / unblock** needs the `vendors.block` permission (Admin and Master Data Manager by default). A reason is required and the vendor can optionally be emailed. Blocking sets the HOLD flags in the ERP export and stops change requests.
- **Needs attention.** The vendor list shows flags (blocked, expired or expiring documents, change pending, re-check due or failed) and a *Needs attention* filter. **Change requests** in the sidebar is the reviewers' queue, with overdue markers; deadlines and escalation work the same way as onboarding.

## Onboarding configuration (Phase 2)

Each workspace has its own **versioned** configuration: tabs → groups → fields, documents, approval levels and the portal guide.

- **Draft → publish:** edits are saved to a draft; publishing validates it and makes it live in one step. Earlier versions are kept and can be previewed or restored into the draft.
- **Validation:** the server checks every condition points at a real field, select/radio fields have options, every level's role exists, at least one level applies to all vendors, and no **built-in** field is deleted or re-keyed. Built-in fields are the ones the ERP export, verification and invites depend on; they can still be relabelled, moved and have their rules changed.
- **Conditions:** *is, is not, is one of, is not one of, more/less than, at least/at most, is empty, is filled in*, on any field or on the vendor type. Fields and documents use one condition each for "required" and "show"; approval levels use *all of / any of* several conditions.
- **Existing data:** answers to a deleted field are kept in the vendor record but no longer shown. Vendors already under review keep the approval steps they had when they submitted, and the config version used is recorded on the vendor.
- **SLAs:** each level can have a deadline in hours. A background sweep (every 5 minutes) emails the approvers once when a step is overdue and escalates to everyone with the `approvals.manage` permission.
- **Who can act on a step:** everyone holding the level's role, **or** one person if an admin reassigned it, **plus** anyone those people have delegated to during an active out-of-office window. The audit log marks delegate actions.

## Security model (Phase 1)

- **Tenancy:** shared database; every business table has `tenant_id`, and every query filters by the tenant of the signed-in session. Cross-tenant access returns 404. This is covered by `tests/tenancy.test.ts`.
- **Sessions:** random token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production); the database stores only its SHA-256 hash, so sessions can be revoked. Staff (`vg_s`) and vendor (`vg_v`) sessions use separate cookies.
- **CSRF:** every state-changing API call must send `X-Requested-With`. Browsers can't add that header cross-site without CORS, which is never enabled.
- **Passwords:** bcrypt cost 12. Minimum 10 characters, three of four character classes, and a common-password block. Accounts lock for 15 minutes after 5 failures. Resets revoke all sessions.
- **2FA:** TOTP (RFC 6238). The secret is encrypted with AES-256-GCM under `ENCRYPTION_KEY`. You get 10 single-use recovery codes, stored hashed. Sessions rotate after 2FA. Admins can reset a user's 2FA.
- **Rate limits:** login/2FA 20 per 15 minutes per IP; reset/invite/OTP 10 per 15 minutes; the whole API 300 per minute.
- **Headers:** Helmet with a strict CSP, `frame-ancestors 'none'`, and `nosniff` on document downloads.
- **Audit:** logins, failures, lockouts, 2FA changes, user/role/setting changes and every vendor action are recorded with actor and IP.
- **Production guard rails:** the server refuses to start with `NODE_ENV=production` unless `ENCRYPTION_KEY` is set and `DEV_SHOW_OTP=false`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + web with hot reload |
| `npm test` | 80 automated tests covering encryption at rest, masking and reveal, DPDP consent, export and erasure, backups, reports and Excel export, ERP push (webhook signatures, Oracle payload, CSV, failures and retry), vendor lifecycle (change requests, renewals, expiry reminders, re-checks, block/unblock), email/SMS/storage/KYC/AI integrations, validators, auth, 2FA, tenant isolation, permissions, configuration editing and publishing, rule-based approval flows, SLA escalation, reassignment, delegation and the full onboarding flow. They use a separate `vendor_onboarding_test` database (see below) |
| `npm run db:setup` | Apply new migrations; load demo data only into an empty database. Never deletes anything |
| `npm run db:backup` / `npm run db:restore -- <folder> --yes` | Back up / restore the database and uploaded documents |
| `npm run db:reencrypt` | Re-encrypt sensitive data after rotating `ENCRYPTION_KEY` |
| `npm run test:e2e` | Build and run the browser tests (first time: `npx playwright install chromium`) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run db:demo-history` | Add a year of demo onboarding history to the `acme` workspace for the dashboard (adds only, runs once) |
| `npm run db:reset -- --yes` | **Wipe** the database and reload the demo data (dev only; refuses without `--yes`) |
| `npm run -w server db:migrate` | Apply pending migrations (use this in production) |
| `npm run -w server db:generate` | Create a new migration after editing `server/src/db/schema.ts` |
| `npm run tenant:create -- …` | Provision a customer workspace |

**Test database (one-time):**

```bash
docker compose exec db psql -U vendor -d vendor_onboarding -c "create database vendor_onboarding_test"
npm test
```

## Where things live

```
server/src/
  app.ts                 Express app (security middleware, routes)
  auth/session.ts        cookie sessions, CSRF guard, requireStaff(permission)
  lib/permissions.ts     permission list + default roles for new workspaces
  lib/crypto.ts          token hashing, AES-GCM encryption
  config/types.ts        config model, zod schema, semantic validation, built-in fields
  config/defaultTemplate.ts  starting configuration for new workspaces
  services/config.ts     draft / publish / versions (cached per tenant)
  services/approvers.ts  who can act on a step (role, assignee, delegation)
  integrations/          email · sms · storage (+ scan) · kyc · ai — each with test + live drivers
  jobs/queue.ts          Postgres job queue (pg-boss) with inline fallback
  services/              tenants, users, workflowEngine, lifecycle (changes, expiry, re-checks, block, flags)
  routes/                staffAuth, vendorAuth, admin (incl. ERP settings), staff (vendors, ERP push), vendorPortal, documents, reports
  services/reports.ts    dashboard metrics, report definitions, Excel export
  integrations/erp/      ERP connectors (Oracle EBS, webhook, CSV/SFTP), push queue, delivery log
  db/schema.ts           tables  ·  drizzle/  SQL migrations
server/tests/            Vitest + Supertest suites
web/src/
  lib/session.tsx        signed-in user, permissions, branding
  pages/auth/            sign-in, 2FA, forgot/reset, accept invite
  pages/admin/           users, roles, workspace, audit log
  pages/                 vendors, vendor detail, account, vendor portal
```

## Still stubbed (planned phases)

| Area | Now | Phase |
|---|---|---|
| Indian-region hosting | Railway (Singapore); the same Docker image runs on AWS Mumbai or Azure Pune | — |

## Deploy

The `Dockerfile` builds one container (API + web) on port 4000. Set these variables:

- `NODE_ENV=production`
- `DATABASE_URL`
- `APP_BASE_URL`
- `ENCRYPTION_KEY`
- `DEV_SHOW_OTP=false`
- `TRUST_PROXY=true` (behind a load balancer)

Run `npm run -w server db:migrate` once against the database, or set `MIGRATE_ON_START=true`.
