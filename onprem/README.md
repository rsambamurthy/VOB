# VendorGate on-premises

Installation kit for running VendorGate on a customer's own servers (Docker Compose, offline-capable).
Full instructions: `docs/VendorGate-OnPrem-Installation-Guide.docx`, `docs/VendorGate-OnPrem-Operations-Runbook.docx`,
`docs/VendorGate-OnPrem-Security-and-Firewall-Guide.docx`.

## Install (customer IT)

```bash
tar -xzf vendorgate-onprem-<version>.tar.gz -C /opt && mv /opt/vendorgate-onprem-<version> /opt/vendorgate && cd /opt/vendorgate
./scripts/verify-kit.sh            # files match the signed release
./scripts/gen-secrets.sh           # makes .env with new secrets — put ENCRYPTION_KEY in your key vault
vi .env                            # address, first administrator, mail relay
cp <cert> certs/vendorgate.crt; cp <key> certs/vendorgate.key; cp <licence> licence/vendorgate.lic
./scripts/preflight.sh             # checks the server
sudo ./scripts/install.sh          # loads images, starts, waits until it answers
```

Ports: **443** staff (intranet), **8443** supplier portal only (publish through your DMZ / WAF), 80 → HTTPS.

## Day to day

| Task | Command |
|---|---|
| Backup (database + documents, encrypted) | `./scripts/backup.sh` → `backups/<date>/` |
| Restore | `./scripts/restore.sh backups/<date>` |
| Upgrade (run from the NEW kit) | `./scripts/upgrade.sh /opt/vendorgate` |
| Roll back the last upgrade | `./scripts/rollback.sh` |
| Rotate the encryption key | `./scripts/rotate-key.sh` |
| Licence | `./scripts/vg.sh licence show` · Administration → Licence |
| Unlock / reset 2FA / reset password | `./scripts/vg.sh user unlock|reset-2fa|reset-password <email>` |
| Support bundle (secrets removed) | `./scripts/support-bundle.sh` |

## For Integratatech: building a kit and issuing licences

```bash
npm run -w server licence -- keygen          # ONCE: private key → ~/.vendorgate/licence-signing-key.pem (keep offline!),
                                             # public key → server/src/lib/licenceKeys.ts (commit it)
./onprem/build-kit.sh 1.4.0 --sign-key ~/.vendorgate/licence-signing-key.pem --docs <folder with the guides + manual>
npm run -w server licence -- issue --customer "Acme Industries Ltd" --id VG-2026-0001 \
    --from 2026-12-01 --until 2027-11-30 --users 50 --vendors 5000 [--no-ai] [--sourcing all] [--contracts] --out acme.lic
# Contracts only (no supplier onboarding): add --contracts --no-onboarding
npm run -w server licence -- show acme.lic
```

The build machine needs Docker and internet access (to pull the base and third-party images). On-prem images refuse
to start in production until the production licence key is set.
