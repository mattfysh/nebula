#!/usr/bin/env bash
# Foreground entry point suitable for a container command or supervisor.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
bash scripts/web.sh &
web=$!
tunnel=''
cleanup() {
  trap - EXIT INT TERM
  [ -z "$tunnel" ] || kill "$tunnel" 2>/dev/null || true
  kill "$web" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT INT TERM
for ((attempt=0; attempt<50; attempt++)); do
  kill -0 "$web" 2>/dev/null || { wait "$web"; exit 1; }
  if bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.WEB_PORT ?? 3000}/`,{signal:AbortSignal.timeout(1000)});process.exit(r.ok?0:1)' 2>/dev/null; then
    bun scripts/tunnel.ts &
    tunnel=$!
    wait -n "$web" "$tunnel"
    exit $?
  fi
  sleep .2
done
echo "Web server did not start" >&2
exit 1
