#!/usr/bin/env bash
# Run a VendorGate administration command, e.g.:
#   ./scripts/vg.sh licence show
#   ./scripts/vg.sh user unlock anita@acme.com
#   ./scripts/vg.sh user reset-2fa anita@acme.com
source "$(dirname "$0")/lib.sh"
cli "$@"
