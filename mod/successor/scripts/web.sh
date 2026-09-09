#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p "${WEB_DATA_DIR:-web-data}"
# OS-held lock releases automatically after crashes; never two writers.
exec flock -n -F -E 73 "${WEB_DATA_DIR:-web-data}/server.lock" bun src/web.ts
