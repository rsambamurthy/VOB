#!/usr/bin/env bash
# Restore a backup made by backup.sh:  ./scripts/restore.sh backups/<folder>
# REPLACES the current database (and adds the backed-up documents).
source "$(dirname "$0")/lib.sh"
src="${1:-}"; [ -d "$src" ] || die "Usage: ./scripts/restore.sh backups/<folder>"
name=$(basename "$src")
[ "$(cd "$src/.." && pwd)" = "$KIT/backups" ] || { cp -r "$src" "backups/$name"; }
read -r -p "This REPLACES all VendorGate data with the backup $name. Type RESTORE to continue: " a; [ "$a" = RESTORE ] || die "Cancelled"
say "Restoring $name"
cli restore "/backups/$name" --yes --production
dc restart app
wait_healthy
ok "Restored $name"
