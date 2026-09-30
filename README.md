# VendorGate — Vendor Onboarding Platform

A multi-tenant SaaS for supplier onboarding: buyer companies invite vendors, and vendors complete a self-service profile (KYC, bank, tax, risk, documents) that goes through a configurable multi-level approval flow before export to the ERP.

**Stack:** React + TypeScript (Vite) · Node + Express + TypeScript · PostgreSQL + Drizzle ORM · Vitest

## Build status

| Phase | Scope | Status |
|---|---|---|
| 0. Prototype | Invite → OTP portal → profile + documents → 3-level approval → Oracle-shaped export | ✅ |
| **1. Platform foundation** | Multi-tenant workspaces, staff accounts (password, invite, reset, lockout), TOTP 2FA + recovery codes, workspace-enforced 2FA, tenant-defined roles & permissions, cookie sessions, CSRF / rate limits / security headers, audit log, SQL migrations, automated tests | ✅ |
| 2. Admin configuration | Per-tenant fields, documents, approval rules, SLAs, delegation — editable in the UI | ⏳ next |
| 3. Integrations | Email/SMS providers, S3 storage, live KYC APIs, AI document extraction, job queue | ⏳ |
| 4. Vendor lifecycle | Change requests + re-approval, document expiry, re-KYC, block/unblock | ⏳ |
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
| `acme` | mdm@acme.test | Master Data Manager (level 3, ERP export) |
| `globex` | admin@globex.test | Administrator of a *separate* company — can't see anything in `acme` |

**Things to try**

1. Sign in as `admin@acme.test` → **Users** → **Invite user** → open **Mailbox** (dev only) → open the invitation *in a private window* (it signs you in as the new user) and set a password.
2. **My account** → turn on two-factor authentication with any authenticator app, sign out and back in.
3. **Workspace** → change the brand colour / portal name; the vendor portal and emails pick it up. Tick **Require 2FA** to force every user to enrol.
4. **Vendors** → **New vendor** → Mailbox → *Open vendor portal* → complete the profile → approve as tax → finance → mdm.
5. Sign in to `globex` and confirm none of Acme's vendors or users are visible.

## Creating a customer workspace

```bash
npm run tenant:create -- --slug initech --name "Initech Ltd" --admin-name "Bill Lumbergh" --admin-email bill@initech.com
```

This creates the workspace with the default roles and prints (and emails) the first administrator's invitation link.

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
| `npm test` | 29 automated tests covering validators, auth, 2FA, tenant isolation, permissions and the full onboarding flow. They use a separate `vendor_onboarding_test` database (see below) |
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
  config/formSchema.ts   onboarding fields & documents (becomes per-tenant in Phase 2)
  config/workflow.ts     default approval levels (by role key)
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
| Email / SMS delivery | Recorded in `email_outbox`, shown in the dev Mailbox | 3 |
| KYC verification | Deterministic mock | 3 |
| File storage | Local `uploads/` folder | 3 |
| AI document extraction | Not yet | 3 |
| Form fields & workflow | Code config shared by all tenants | 2 |
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
