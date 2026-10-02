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
| 4. Vendor lifecycle | Change requests + re-approval, document expiry, re-KYC, block/unblock | ⏳ next |
| 5. Reports & ERP | Funnel, TAT, ageing, Excel; ERP push adapters | ⏳ |
| 6. Hardening | Field-level encryption, DPDP, E2E tests, CI, deployment | ⏳ |

## Quick start (Windows / macOS / Linux)

Prerequisites: **Node 20+** and **Docker Desktop** (running), or your own Postgres 14+.

```bash
npm install
npm run db:up                                   # Postgres in Docker on port 5433
copy server\.env.example server\.env            # macOS/Linux: cp server/.env.example server/.env
npm run db:setup                                # creates tables (migrations) + demo data
npm run dev                                     # web → http://localhost:5173, API → :4000
```

If `db:setup` fails right after `db:up`, wait about 10 seconds for Postgres to start and run it again.
`db:setup` **wipes and reloads** the demo data, so only run it on a dev database.

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
| `npm test` | 49 automated tests covering email/SMS/storage/KYC/AI integrations, validators, auth, 2FA, tenant isolation, permissions, configuration editing and publishing, rule-based approval flows, SLA escalation, reassignment, delegation and the full onboarding flow. They use a separate `vendor_onboarding_test` database (see below) |
| `npm run db:setup` | Drop, migrate, reseed (dev only) |
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
  services/              tenants, users, workflowEngine
  routes/                staffAuth, vendorAuth, admin, staff (vendors), vendorPortal, documents
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
| PAN / bank encryption at rest | Plain columns | 6 |

## Deploy

The `Dockerfile` builds one container (API + web) on port 4000. Set these variables:

- `NODE_ENV=production`
- `DATABASE_URL`
- `APP_BASE_URL`
- `ENCRYPTION_KEY`
- `DEV_SHOW_OTP=false`
- `TRUST_PROXY=true` (behind a load balancer)

Run `npm run -w server db:migrate` once against the database, or set `MIGRATE_ON_START=true`.
