#!/usr/bin/env bash
# Make .env from .env.template, with new random secrets. Never overwrites an existing .env.
source "$(dirname "$0")/lib.sh"
if [ -f .env ]; then ok ".env already exists — keeping it"; exit 0; fi
say "Creating .env with new secrets"
cp .env.template .env && chmod 600 .env
setenv VG_VERSION "$(kit_version)"
setenv ENCRYPTION_KEY "$(openssl rand -base64 32)"
setenv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
ok ".env created (readable by this user only)"
warn "Copy ENCRYPTION_KEY from .env into your key vault NOW. Without it, encrypted data and backups cannot be read."
warn "Then edit .env: VG_HOSTNAME, APP_BASE_URL, the first administrator and your mail server (SMTP_*)."
