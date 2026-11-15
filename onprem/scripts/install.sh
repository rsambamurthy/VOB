#!/usr/bin/env bash
# First installation:  ./scripts/install.sh [path/to/vendorgate.lic]
source "$(dirname "$0")/lib.sh"
say "VendorGate $(kit_version) — installation"
[ -f checksums.sha256 ] && ./scripts/verify-kit.sh
./scripts/gen-secrets.sh
if grep -q "example.com" .env; then warn "Edit .env first (address, first administrator, mail server), then run ./scripts/install.sh again."; exit 1; fi
./scripts/preflight.sh
./scripts/load-images.sh
mkdir -p licence backups
# The app runs as user 1000 inside its container and writes backups here.
if [ "$(id -u)" = 0 ]; then chown 1000:1000 backups && chmod 770 backups; else chmod 777 backups; warn "backups/ is writable by everyone on this server; as root: chown 1000:1000 backups && chmod 770 backups"; fi
if [ -n "${1:-}" ]; then cp "$1" licence/vendorgate.lic && ok "Licence file copied to licence/vendorgate.lic"; fi
[ -f licence/vendorgate.lic ] || warn "No licence yet: VendorGate starts read-only until you install one (Administration → Licence)."
say "Starting VendorGate"
dc up -d
wait_healthy
cli version
cli licence show || true
echo
ok "Installed. Staff: https://$(envval VG_HOSTNAME)/login   Suppliers (via your DMZ): https://$(envval VG_HOSTNAME)/"
ok "The first administrator ($(envval BOOTSTRAP_ADMIN_EMAIL)) was emailed an invitation. The link is also in: docker compose logs app | grep bootstrap"
warn "Next: take a first backup (./scripts/backup.sh) and store ENCRYPTION_KEY in your key vault."
