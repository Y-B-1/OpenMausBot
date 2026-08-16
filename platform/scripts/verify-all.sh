#!/usr/bin/env bash
# Gate for ralph-loop DONE: typecheck+tests, prod build, one-command smoke, full-surface e2e.
set -e
cd "$(dirname "$0")/.."
corepack pnpm run check
corepack pnpm run build:web
test -f scripts/smoke.sh || { echo "MISSING scripts/smoke.sh"; exit 1; }
bash scripts/smoke.sh
test -f scripts/e2e-demo.mjs || { echo "MISSING scripts/e2e-demo.mjs"; exit 1; }
node scripts/e2e-demo.mjs
