# Shared helpers for the VendorGate on-prem scripts. Sourced, not run.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KIT"
say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()  { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
dc()   { docker compose --project-directory "$KIT" -f "$KIT/docker-compose.yml" "$@"; }
envval() { [ -f "$KIT/.env" ] && grep -E "^$1=" "$KIT/.env" | tail -1 | cut -d= -f2- || true; }
setenv() { # setenv KEY VALUE — replace or add a line in .env
  if grep -qE "^$1=" "$KIT/.env"; then sed -i "s|^$1=.*|$1=$2|" "$KIT/.env"; else echo "$1=$2" >> "$KIT/.env"; fi; }
cli()  { dc exec -T app node server/dist/cli.js "$@"; }
kit_version() { cat "$KIT/VERSION" 2>/dev/null || echo unknown; }
wait_healthy() { # wait until /api/health answers through the app container
  say "Waiting for VendorGate to start (database updates run on start)…"
  for i in $(seq 1 90); do
    if dc exec -T app node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ok "VendorGate is up"; return 0; fi
    sleep 4
  done
  dc logs --tail 80 app; die "VendorGate did not start within 6 minutes — see the log above"
}
