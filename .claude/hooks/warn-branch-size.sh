#!/bin/bash
# LANDING CADENCE — warn (never block) when a branch runs long without landing.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Same bypass switch as the other guards, so YOLO/ralph runs are unaffected.
PM=$(echo "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)
if [ "$PM" = "bypassPermissions" ] || [ "${CHARGE_YOLO:-0}" = "1" ] || [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/.bypass-guards" ]; then
  exit 0
fi

# Only on a real commit. `git commit` inside a string, a `--dry-run`, or
# `git commit-graph` must not trip it.
echo "$COMMAND" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit([[:space:]]|$)' || exit 0
echo "$COMMAND" | grep -qE '\-\-dry-run' && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$BRANCH" = "main" ] && exit 0
[ "$BRANCH" = "HEAD" ] && exit 0

# origin/main is the deploy boundary. If the ref is missing (offline, fresh
# clone) stay silent rather than guess.
git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null)
[ -z "$AHEAD" ] && exit 0

CEILING=10
[ "$AHEAD" -lt "$CEILING" ] && exit 0

echo "CADENCE: '$BRANCH' is $AHEAD commits ahead of origin/main. The ceiling is $CEILING or one working session, whichever comes first (CLAUDE.md 'Landing cadence'). Committing is fine — but land now: push the branch, open the PR, merge when gates are green. Then start the next group on a new branch." >&2
exit 0
