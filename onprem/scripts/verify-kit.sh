#!/usr/bin/env bash
# Check that the kit's files are exactly as Integratatech released them (checksums, and their signature if present).
source "$(dirname "$0")/lib.sh"
say "Checking the kit files"
[ -f checksums.sha256 ] || die "checksums.sha256 is missing — the kit is incomplete"
sha256sum --quiet -c checksums.sha256 || die "Some files don't match the release — download the kit again"
ok "All files match checksums.sha256"
if [ -f checksums.sha256.sig ] && [ -f keys/integratatech-release.pub ]; then
  openssl pkeyutl -verify -pubin -inkey keys/integratatech-release.pub -rawin -in checksums.sha256 -sigfile checksums.sha256.sig >/dev/null \
    && ok "Signed by Integratatech" || die "The release signature is not valid"
else warn "No release signature in this kit"; fi
