# Upstream test baseline (P0) — pinned 2026-08-17

Authoritative "must not get worse" list for the port passes.

## How to run the suite correctly

```sh
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"   # Node >= 24
mkdir -p /tmp/omb-test-data                                  # SHORT path (see below)
OMB_DATA_DIR=/tmp/omb-test-data corepack pnpm test
```

- `server/config.ts:28` — `DATA_DIR = process.env.OMB_DATA_DIR ?? ~/.openmausbot`.
  Every server test that touches `DATA_DIR` (store, config, drivers) reads it at
  import time, so the env var must be set for the whole `vitest run`.
- **The data dir path must be SHORT.** `server/drivers/claude.test.ts`
  ("brokers a permission ask…") creates a unix domain socket inside the data
  dir; macOS caps `sun_path` at ~104 bytes, so a long `OMB_DATA_DIR` fails it
  with `EINVAL` on `listen`/`connect`. `/tmp/<something short>` is safe.

## Pinned baseline (isolated short `OMB_DATA_DIR`, dev stack allowed to run)

```
Test Files  35 passed (35)
Tests       287 passed | 8 skipped (295)
```

**Zero failing files.** "Suite green" for every later pass means: no failures
at all beyond this list (i.e. none).

## Characterization of the 35 failures / 10 files seen at planning time

The planning session ran `pnpm test` WITHOUT `OMB_DATA_DIR`, so the suite
shared `~/.openmausbot` with the live dev stack (server 8799). Re-run under an
isolated data dir reproduces **none** of them: all 10 previously-failing files
pass. Cause for the whole set: shared-state interference (tests reading/
wiping/racing the live app's `bots.json` / `config.json` / `messages-*.json` /
events dir), not code defects. One additional failure mode was discovered and
solved while pinning: the socket-path length limit documented above.

| Failing file (planning run) | Cause | Fixed by isolation? |
|---|---|---|
| all 10 files | shared `~/.openmausbot` with the running dev stack | yes — all pass |
