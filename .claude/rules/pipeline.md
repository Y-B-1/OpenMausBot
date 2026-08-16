---
paths:
  - "package.json"
  - "scripts/**"
  - ".github/**"
---

# Pipeline mechanics (hard-won)

- **Honest exit codes always:** `cmd > log 2>&1; echo exit:$?`. Never pipe a
  test run through `tail`/`grep` directly — the pipe's status replaces the
  command's. `GIT_PAGER=cat` for any `git diff` / `git show`.
- **vitest stalled at 0% CPU** → kill, retry with `--pool=threads`.
- **In a fresh worktree, PROVE `node_modules` before believing any gate.**
  Package installs under a tool sandbox can print success, exit 0, and install
  nothing. Run `ls node_modules/.bin/vitest` before the first gate and re-run
  the install if it is missing.
- **Validate any liveness/stall detector on a KNOWN-ALIVE run before trusting
  it.** A predicate that errors returns the same signal as the condition being
  true. Use portable epoch math, not GNU-only find flags.
- **Never kill or resume a workflow on a detector's word alone** — confirm
  against transcript mtime. Resuming a live run duplicates work.
