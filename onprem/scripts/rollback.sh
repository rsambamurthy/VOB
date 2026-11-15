#!/usr/bin/env bash
# Go back to the version before the last upgrade, with the data from the backup taken just before it.
# Anything entered since the upgrade is lost — the runbook explains when to roll back.
source "$(dirname "$0")/lib.sh"
[ -f .upgrade-state ] || die "No upgrade to roll back (.upgrade-state is missing)"
. ./.upgrade-state
docker image inspect "vendorgate:$VG_PREVIOUS_VERSION" >/dev/null 2>&1 || die "The image vendorgate:$VG_PREVIOUS_VERSION is not on this server — load it from the previous kit (./scripts/load-images.sh)"
read -r -p "Roll back to $VG_PREVIOUS_VERSION and restore $VG_PREVIOUS_BACKUP? Data entered since the upgrade is lost. Type ROLLBACK: " a; [ "$a" = ROLLBACK ] || die "Cancelled"
setenv VG_VERSION "$VG_PREVIOUS_VERSION"
dc up -d app
wait_healthy
yes RESTORE | ./scripts/restore.sh "$VG_PREVIOUS_BACKUP"
rm -f .upgrade-state
ok "Rolled back to $VG_PREVIOUS_VERSION"
