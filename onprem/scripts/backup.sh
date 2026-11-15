#!/usr/bin/env bash
# Encrypted backup of the database and the documents, copied to ./backups on this server.
# Copy ./backups to another place too (backup server, tape, cloud) — the runbook explains.
source "$(dirname "$0")/lib.sh"
say "Backing up VendorGate"
out=$(cli backup --encrypt | tee /dev/stderr | sed -n 's/^Saved \(.*\)\/database\.dump\.enc.*/\1/p' | tail -1)
[ -n "$out" ] || die "The backup did not finish"
name=$(basename "$out")
[ -d "backups/$name" ] || die "backups/$name is missing on this server"
cp .env "backups/$name/env.copy" && chmod 600 "backups/$name/env.copy"
echo "$(kit_version)" > "backups/$name/VERSION"
ok "Backup in backups/$name (database, documents, settings). It is encrypted with ENCRYPTION_KEY."
