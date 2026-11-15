#!/usr/bin/env bash
# Upgrade to the version in THIS kit folder. Run from the new kit, pointing at the installed one:
#   ./scripts/upgrade.sh /opt/vendorgate
# Steps: check the kit → backup → load the new images → switch version → start → check. Rollback: ./scripts/rollback.sh
source "$(dirname "$0")/lib.sh"
NEW="$KIT"; TARGET="${1:-}"; [ -d "$TARGET" ] && [ -f "$TARGET/.env" ] || die "Usage: ./scripts/upgrade.sh <installed folder, e.g. /opt/vendorgate>"
new_version=$(kit_version)
old_version=$(grep -E '^VG_VERSION=' "$TARGET/.env" | cut -d= -f2)
say "Upgrading VendorGate $old_version → $new_version"
[ -f checksums.sha256 ] && ./scripts/verify-kit.sh
./scripts/load-images.sh
cd "$TARGET"; KIT="$TARGET"
say "Backup before the upgrade (database updates can't be undone without it)"
"$NEW/scripts/backup.sh"
last=$(ls -1d backups/*/ | tail -1)
echo "VG_PREVIOUS_VERSION=$old_version" > .upgrade-state; echo "VG_PREVIOUS_BACKUP=$last" >> .upgrade-state
# New scripts, compose file, proxy settings and docs; .env, certs, licence and backups are kept.
cp -r "$NEW/scripts" "$NEW/docker-compose.yml" "$NEW/nginx" "$NEW/VERSION" "$NEW/.env.template" "$TARGET/"; [ -d "$NEW/docs" ] && cp -r "$NEW/docs" "$TARGET/"
setenv VG_VERSION "$new_version"
dc up -d
wait_healthy
cli version
ok "Upgraded to $new_version. If something is wrong: ./scripts/rollback.sh"
