#!/usr/bin/env bash
# Collect what Integratatech support needs (versions, status, recent logs) — secrets are removed. Send the .tar.gz file.
source "$(dirname "$0")/lib.sh"
d="support-$(hostname)-$(date +%Y%m%d-%H%M)"; mkdir -p "/tmp/$d"
say "Collecting support information"
{ echo "kit: $(kit_version)"; cli version 2>&1 || true; docker version --format 'docker {{.Server.Version}}' 2>&1; docker compose version; uname -a; } > "/tmp/$d/versions.txt"
dc ps > "/tmp/$d/containers.txt" 2>&1 || true
cli licence show > "/tmp/$d/licence.txt" 2>&1 || true
df -h > "/tmp/$d/disk.txt"; free -m > "/tmp/$d/memory.txt" 2>&1 || true
for s in app db proxy clamav; do dc logs --no-color --tail 3000 "$s" > "/tmp/$d/log-$s.txt" 2>&1 || true; done
# Settings with every secret blanked out.
sed -E 's/^((ENCRYPTION_KEY|ENCRYPTION_KEY_PREVIOUS|POSTGRES_PASSWORD|SMTP_PASS|[A-Z_]*(TOKEN|SECRET|API_KEY|AUTH_KEY|PASSWORD|CONNECTION_STRING)[A-Z_]*)=).*/\1***removed***/' .env > "/tmp/$d/settings.txt"
tar -czf "$d.tar.gz" -C /tmp "$d" && rm -rf "/tmp/$d"
ok "Created $d.tar.gz — check it, then send it to support@integratatech.ai"
