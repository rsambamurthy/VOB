# Deploying VendorGate on Railway

One Railway **service** runs the whole app (API + web, from the `Dockerfile`), next to a Railway **Postgres** database and a **volume** for uploaded documents and backups. Allow about 20 minutes the first time.

## 0. Before you start

1. The code is on GitHub, and CI (the **Actions** tab) passes.
2. Generate an encryption key **once** and keep a copy somewhere safe, such as a password manager:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   This key encrypts PAN and bank numbers, ERP passwords and backups. **If you lose it, that data can't be recovered.** Never change it without following "Rotating the key" below.
3. Choose an email provider. **Railway blocks outbound SMTP on Free, Trial and Hobby plans**, so use an HTTPS email API: **Resend** (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`) or SendGrid. SMTP works only on Railway Pro.

## 1. Create the project

1. In Railway, click **New project → Deploy from GitHub repo** and pick your repository. Railway reads `railway.json` and builds the `Dockerfile`.
2. In the same project, click **+ New → Database → PostgreSQL**.
3. On the app service, open **Settings → Volumes**, add a volume and mount it at **`/data`**. Uploaded documents and backups live there.
4. Open **Settings → Networking → Generate domain** (or add your own domain, for example `vendors.yourcompany.com`).

## 2. Variables (app service → Variables)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`, or, to keep VendorGate in its own database on a shared Postgres server: `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/vendorgate` together with `CREATE_DATABASE_IF_MISSING=true` |
| `ENCRYPTION_KEY` | the key from step 0 |
| `APP_BASE_URL` | `https://<your domain>` — exactly as people will open it |
| `EMAIL_PROVIDER` | `resend` (recommended on Railway) with `RESEND_API_KEY`, or `sendgrid` with `SENDGRID_API_KEY`, or `smtp` with `SMTP_*` (Railway Pro only); plus `EMAIL_FROM`, e.g. `VendorGate <no-reply@yourdomain.com>` |
| `BACKUP_SCHEDULE` | `30 2 * * *` (encrypted database backup every night at 02:30 IST, kept 14 days in `/data/uploads/_backups`) |
| `BOOTSTRAP_ADMIN_EMAIL` | **first deploy only**: your email |
| `BOOTSTRAP_ADMIN_NAME` | **first deploy only**: your name |
| `BOOTSTRAP_COMPANY` | **first deploy only**: company name |
| `BOOTSTRAP_WORKSPACE` | **first deploy only**: workspace ID people type at sign-in, for example `acme` |

The image already sets `NODE_ENV=production`, `DEV_SHOW_OTP=false`, `TRUST_PROXY=true`, `MIGRATE_ON_START=true` and `UPLOAD_DIR=/data/uploads`.

Optional, all described in `server/.env.example`:
- **SMS:** `SMS_PROVIDER` with MSG91 or Twilio.
- **Verification:** `KYC_PROVIDER=surepass` with `SUREPASS_TOKEN`.
- **AI document reading:** `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`.
- **Cloud storage:** `STORAGE_DRIVER=s3` with the `S3_*` settings, instead of the volume.

## 3. First start

1. Deploy, either from the button or by pushing to `main`. The logs should show:
   ```
   [startup] API listening …
   [bootstrap] Workspace "acme" created. Invitation for you@company.com: https://…/accept-invite/…
   ```
2. Open the invitation link (it is also emailed), set your password and set up two-factor authentication.
3. **Remove the `BOOTSTRAP_*` variables.** They only act on an empty database, but leaving them around invites confusion.
4. In the app, go through:
   - **Workspace:** branding, and **Privacy & data retention** (have the privacy notice reviewed, and set the grievance officer email).
   - **Users:** invite your team.
   - **Configuration:** your fields, documents and approval flow.
   - **Integrations:** send a test email.
   - **ERP integration.**

To add more customer workspaces later, run this from your computer against the production database (copy the database's *public* URL from Railway):
```powershell
$env:DATABASE_URL="<public database url>"; $env:ENCRYPTION_KEY="<key>"; npm run tenant:create -- --slug globex --name "Globex Ltd" --admin-name "…" --admin-email "…"
```

## 4. Day to day

- **Deploys:** every push to `main` builds and deploys. Database changes are applied automatically on start.
- **Health check:** Railway checks `/api/health`, which only returns 200 when the database answers.
- **Backups:**
  - **Nightly:** an encrypted file is written to the volume. Also turn on Railway's own Postgres backups if your plan has them.
  - **Copy for your computer:** `railway run npm run db:backup -- --encrypt`, or `npm run db:backup` with `DATABASE_URL` set to the public database URL.
  - **Restore:** `npm run db:restore -- <folder or .dump.enc file> --yes` with `DATABASE_URL` pointing at the target. Restoring into production also needs `--production`.

## Rotating the encryption key

1. Generate a new key.
2. Set `ENCRYPTION_KEY_PREVIOUS` = the old key and `ENCRYPTION_KEY` = the new key, then deploy.
3. Run `npm run db:reencrypt` against the database.
4. Remove `ENCRYPTION_KEY_PREVIOUS`. Old backups still need the old key, so keep it with them.

## Data location

Railway's nearest region to India is Singapore. DPDP currently allows transfers outside India except to countries the government restricts. If a customer requires Indian hosting, the same `Dockerfile` runs on AWS (Mumbai or Hyderabad) or Azure (Pune or Chennai) with managed Postgres and S3/Blob storage.
