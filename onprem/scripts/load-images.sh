#!/usr/bin/env bash
# Load the container images shipped in ./images (no internet needed).
source "$(dirname "$0")/lib.sh"
say "Loading container images"
shopt -s nullglob
for f in images/*.tar images/*.tar.gz; do echo "  $f"; docker load -i "$f" | sed 's/^/  /'; done
ok "Images loaded"
