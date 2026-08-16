#!/usr/bin/env bash
# One-command smoke test: boot the relay (serving the built web UI) on an
# ephemeral port with a throwaway data dir, verify index + login, clean up.
set -euo pipefail

PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.22.2/bin/node}"

# (a) pick an ephemeral port
PORT="$("$NODE_BIN" -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

# (b) throwaway data dir + relay boot
DATA_DIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# (c) built web is required (relay serves web/dist)
if [ ! -f "$PLATFORM_DIR/web/dist/index.html" ]; then
  echo "web/dist missing — run: corepack pnpm run build:web" >&2
  exit 1
fi

cd "$PLATFORM_DIR"
ATRIUM_PORT="$PORT" ATRIUM_DATA_DIR="$DATA_DIR" \
  "$NODE_BIN" --experimental-strip-types server/main.ts &
SERVER_PID=$!

# wait for the relay to come up (max ~10s)
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 0.2
done

# (d) assertions
INDEX_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
echo "GET / -> $INDEX_CODE"
[ "$INDEX_CODE" = "200" ]

LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"name":"smoke-admin"}' \
  "http://127.0.0.1:$PORT/api/login")"
echo "POST /api/login -> $LOGIN_CODE"
[ "$LOGIN_CODE" = "200" ]

echo "SMOKE OK (port $PORT)"
