#!/usr/bin/env bash
# Change ENCRYPTION_KEY (e.g. yearly, or if it may have leaked). Takes a backup first; keep the OLD key with the old backups.
source "$(dirname "$0")/lib.sh"
old="$(envval ENCRYPTION_KEY)"; [ -n "$old" ] || die "ENCRYPTION_KEY is not set"
read -r -p "Rotate the encryption key now? Type ROTATE: " a; [ "$a" = ROTATE ] || die "Cancelled"
./scripts/backup.sh
new="$(openssl rand -base64 32)"
setenv ENCRYPTION_KEY_PREVIOUS "$old"; setenv ENCRYPTION_KEY "$new"
dc up -d app; wait_healthy
cli reencrypt
sed -i '/^ENCRYPTION_KEY_PREVIOUS=/d' .env
dc up -d app; wait_healthy
ok "Key rotated. Store the NEW key in your key vault; keep the OLD key with backups taken before today."
