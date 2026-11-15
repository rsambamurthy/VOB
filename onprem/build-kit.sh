#!/usr/bin/env bash
# Integratatech: build the on-prem installation kit (run on a build machine with Docker and internet access).
#
#   ./onprem/build-kit.sh 1.4.0 [--sign-key ~/.vendorgate/licence-signing-key.pem] [--docs <folder with the guides>]
#
# Produces onprem/out/vendorgate-onprem-<version>/ and vendorgate-onprem-<version>.tar.gz (+ .sha256):
#   images/      the VendorGate image and the pinned third-party images, as tar files (offline install)
#   scripts/     install, preflight, backup/restore, upgrade/rollback, key rotation, support bundle
#   docs/        Installation Guide, Operations Runbook, Security & Firewall Guide, User Manual, Feature List
#   sbom.cdx.json, checksums.sha256 (+ .sig), keys/integratatech-release.pub
set -euo pipefail
VERSION="${1:?usage: build-kit.sh <version> [--sign-key file] [--docs folder]}"; shift
SIGN_KEY=""; DOCS=""
while [ $# -gt 0 ]; do case "$1" in --sign-key) SIGN_KEY="$2"; shift 2;; --docs) DOCS="$2"; shift 2;; *) echo "unknown option $1"; exit 1;; esac; done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; HERE="$ROOT/onprem"
OUT="$HERE/out/vendorgate-onprem-$VERSION"
# Third-party images, pinned. Update deliberately and test before a release.
IMAGES=("postgres:16" "nginx:1.27-alpine" "clamav/clamav:stable" "minio/minio:latest")

grep -q "PRODUCTION_PUBLIC_KEY: string | null = null" "$ROOT/server/src/lib/licenceKeys.ts" && { echo "No production licence key in server/src/lib/licenceKeys.ts — run 'npm run -w server licence -- keygen' once and commit it."; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain)" ] || echo "WARNING: uncommitted changes are included in this build."

echo "==> Tests"
( cd "$ROOT" && npm run -w server test >/dev/null ) || { echo "Server tests failed — not building a kit."; exit 1; }

echo "==> VendorGate image $VERSION"
docker build --pull --build-arg APP_VERSION="$VERSION" -t "vendorgate:$VERSION" "$ROOT"

rm -rf "$OUT"; mkdir -p "$OUT/images" "$OUT/keys" "$OUT/licence" "$OUT/certs" "$OUT/backups" "$OUT/docs"
echo "==> Saving images"
docker save "vendorgate:$VERSION" | gzip > "$OUT/images/vendorgate-$VERSION.tar.gz"
for img in "${IMAGES[@]}"; do docker pull -q "$img" >/dev/null; f="$(echo "$img" | tr '/:' '__')"; docker save "$img" | gzip > "$OUT/images/$f.tar.gz"; done

echo "==> Files"
cp "$HERE/docker-compose.yml" "$HERE/README.md" "$OUT/"
sed "s/__VERSION__/$VERSION/" "$HERE/.env.template" > "$OUT/.env.template"
cp -r "$HERE/nginx" "$HERE/scripts" "$OUT/"
echo "$VERSION" > "$OUT/VERSION"
printf 'Put your TLS certificate here:\n  vendorgate.crt  (certificate + intermediate chain)\n  vendorgate.key  (private key)\n' > "$OUT/certs/README.txt"
printf 'Put the licence file from Integratatech here as vendorgate.lic (or install it later under Administration → Licence).\n' > "$OUT/licence/README.txt"
[ -n "$DOCS" ] && cp "$DOCS"/* "$OUT/docs/" || cp "$HERE"/docs/* "$OUT/docs/" 2>/dev/null || true
# The public key that verifies licences and this kit's signature.
node -e "import('$ROOT/server/dist/lib/licenceKeys.js').then(m=>process.stdout.write(m.PRODUCTION_PUBLIC_KEY+'\n'))" > "$OUT/keys/integratatech-release.pub" 2>/dev/null \
  || sed -n '/PRODUCTION_PUBLIC_KEY/,/END PUBLIC KEY/p' "$ROOT/server/src/lib/licenceKeys.ts" | sed -n '/BEGIN/,/END/p' | tr -d '`;' > "$OUT/keys/integratatech-release.pub"

echo "==> Software bill of materials"
( cd "$ROOT" && npm sbom --sbom-format cyclonedx --omit dev -w server > "$OUT/sbom.cdx.json" ) || echo "  (npm sbom not available — skipped)"

echo "==> Checksums and signature"
( cd "$OUT" && find . -type f ! -name checksums.sha256 ! -name checksums.sha256.sig | sort | xargs sha256sum > checksums.sha256 )
if [ -n "$SIGN_KEY" ]; then openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$OUT/checksums.sha256" -out "$OUT/checksums.sha256.sig"; echo "  signed"; else echo "  not signed (use --sign-key)"; fi

echo "==> Archive"
( cd "$HERE/out" && tar -czf "vendorgate-onprem-$VERSION.tar.gz" "vendorgate-onprem-$VERSION" && sha256sum "vendorgate-onprem-$VERSION.tar.gz" > "vendorgate-onprem-$VERSION.tar.gz.sha256" )
du -sh "$HERE/out/vendorgate-onprem-$VERSION.tar.gz"
echo "Done: onprem/out/vendorgate-onprem-$VERSION.tar.gz"
