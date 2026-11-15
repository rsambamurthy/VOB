#!/usr/bin/env bash
# Check this server before installing or upgrading. Exits non-zero if something must be fixed.
source "$(dirname "$0")/lib.sh"
bad=0; need() { fail "$1"; bad=1; }
say "Server"
command -v docker >/dev/null && ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')" || need "Docker is not installed"
docker compose version >/dev/null 2>&1 && ok "$(docker compose version | head -1)" || need "Docker Compose v2 (docker compose) is not available"
docker info >/dev/null 2>&1 || need "Docker is not running, or this user can't use it (add them to the docker group)"
cpu=$(nproc); [ "$cpu" -ge 4 ] && ok "$cpu CPUs" || { [ "$cpu" -ge 2 ] && warn "$cpu CPUs (4 recommended)" || need "$cpu CPU (at least 2)"; }
mem=$(awk '/MemTotal/ {print int($2/1024/1024+0.5)}' /proc/meminfo); [ "$mem" -ge 8 ] && ok "${mem} GB memory" || { [ "$mem" -ge 4 ] && warn "${mem} GB memory (8 GB recommended)" || need "${mem} GB memory (at least 4 GB)"; }
disk=$(df -BG --output=avail "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)" | tail -1 | tr -dc 0-9); [ "${disk:-0}" -ge 50 ] && ok "${disk} GB free for Docker" || { [ "${disk:-0}" -ge 20 ] && warn "${disk} GB free (50 GB+ recommended; documents and backups grow)" || need "${disk} GB free (at least 20 GB)"; }
say "Settings"
if [ -f .env ]; then
  ok ".env present"
  for k in VG_VERSION VG_HOSTNAME APP_BASE_URL ENCRYPTION_KEY POSTGRES_PASSWORD EMAIL_FROM; do v="$(envval $k)"; [ -n "$v" ] && [[ "$v" != __* ]] || need "$k is not set in .env"; done
  [[ "$(envval APP_BASE_URL)" == https://* ]] || need "APP_BASE_URL must start with https://"
  [[ "$(envval VG_HOSTNAME)" == *example.com ]] && need "VG_HOSTNAME is still the example — set your address"
  [ "$(stat -c %a .env)" = "600" ] || warn ".env should be readable by administrators only: chmod 600 .env"
else need ".env is missing — run ./scripts/gen-secrets.sh"; fi
say "Certificate"
if [ -f certs/vendorgate.crt ] && [ -f certs/vendorgate.key ]; then
  end=$(openssl x509 -enddate -noout -in certs/vendorgate.crt 2>/dev/null | cut -d= -f2) && ok "certs/vendorgate.crt valid until $end" || need "certs/vendorgate.crt is not a readable certificate"
  host="$(envval VG_HOSTNAME)"; [ -n "$host" ] && { openssl x509 -noout -checkhost "$host" -in certs/vendorgate.crt 2>/dev/null | grep -q "does match" && ok "Certificate covers $host" || warn "Certificate may not cover $host"; }
else need "Put your certificate in certs/vendorgate.crt (full chain) and certs/vendorgate.key"; fi
say "Network"
host="$(envval VG_HOSTNAME)"; [ -n "$host" ] && { getent hosts "$host" >/dev/null && ok "$host resolves ($(getent hosts "$host" | awk '{print $1}' | head -1))" || warn "$host does not resolve yet (set up DNS)"; }
for p in "$(envval VG_STAFF_PORT)" "$(envval VG_SUPPLIER_PORT)" "$(envval VG_HTTP_PORT)"; do [ -z "$p" ] && continue
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then dc ps --status running proxy 2>/dev/null | grep -q proxy && ok "Port $p in use by VendorGate" || need "Port $p is already in use"; else ok "Port $p free"; fi; done
smtp="$(envval SMTP_HOST)"; port="$(envval SMTP_PORT)"
[ -n "$smtp" ] && [[ "$smtp" != *example.com ]] && { timeout 5 bash -c "</dev/tcp/$smtp/${port:-587}" 2>/dev/null && ok "Mail server $smtp:${port:-587} reachable" || warn "Can't reach mail server $smtp:${port:-587}"; }
check_out() { timeout 5 bash -c "</dev/tcp/$1/443" 2>/dev/null && ok "$2: $1 reachable" || warn "$2: $1 not reachable (allow it in the firewall, or keep that feature off)"; }
[ "$(envval AI_PROVIDER)" = anthropic ] && check_out api.anthropic.com "AI"
[ "$(envval KYC_PROVIDER)" = surepass ] && check_out kyc-api.surepass.io "Verification checks"
[ "$(envval SANCTIONS_PROVIDER)" = opensanctions ] && check_out api.opensanctions.org "Sanctions screening"
[ "$(envval SMS_PROVIDER)" = msg91 ] && check_out control.msg91.com "SMS"
[ "$(envval SMS_PROVIDER)" = twilio ] && check_out api.twilio.com "SMS"
echo
[ $bad = 0 ] && ok "Ready" || die "Fix the items marked ✗ and run this again"
