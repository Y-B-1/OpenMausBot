# Atrium prototype — execution plan

Waves are sequential; tickets within a wave are one builder's scope.
Gate per wave: `pnpm -C platform check` (tsc + vitest) green, committed, pushed.

## Wave 1 — server core (`platform/shared`, `platform/server`)
- T1 shared/contracts.ts: EventKind enum-consts, AtriumEvent, records (User, Agent, Channel, MemoryEntry, Approval), wire types.
- T2 server/store.ts: NDJSON EventStore (append, replay) + projections (channels, members, transcripts, memory, approvals).
- T3 server/relay.ts: node:http + ws; auth-lite sessions; resolveOrg(host) seam; REST commands (create channel, post message, invite agent, respond approval, review memory); WS subscribe with membership check BEFORE registration; channel-scoped fan-out.
- T4 tests: pipeline ordering, scoped fan-out (member vs non-member), membership races, projection rebuild from log.

## Wave 2 — agent core (`platform/server/agents`)
- T5 AgentDriver iface + mock driver (deterministic scripted behavior incl. one tool call requiring approval, one memory proposal).
- T6 anthropic driver: @anthropic-ai/sdk, streaming, model from agent.model_policy (default haiku-class), tool use (sandbox.exec, memory.propose) via tool-runner loop; refusal/fallback handling.
- T7 dispatcher: @mention + DM routing (longest-name-wins from upstream), per-channel single-in-flight queue (explicit QUEUE policy, max batch 10 — red-team note on Buzz Drop default), context assembly: transcript window + memory injection as labeled DATA blocks (org core + space blocks + author profile).
- T8 memory-gates: proposals land quarantined/agent_proposed; accept/reject commands flip trust tier; only human_confirmed+ auto-injects; supersede-not-delete with version chain; tests.
- T9 SandboxProvider iface + LocalSandbox (scratch dir, allowlisted argv: node/ls/cat/echo/wc, no shell string, env scrubbed, 10s timeout), every exec appended as kind-50 audit; approval required unless on agent allowlist; tests.

## Wave 3 — web UI (`platform/web`)
- T10 Vite React app: token-based theming (light/dark), app shell (org rail, channel list, roster with human/agent badges).
- T11 Chat view: transcript, streaming deltas, @mention autocomplete, approval cards inline (approve/deny), agent activity chips.
- T12 Memory panel: review queue (proposed entries with provenance), accept/reject, tier browser (org/space/personal).
- T13 Computer panel: per-agent sandbox audit trail (exec log with stdout), live during turns.
- T14 e2e smoke: script that boots server+web, drives a demo conversation with the mock agent, screenshots.

## Wave 4 — close
- T15 README in platform/; AGENT-MEMORY update; final screenshot evidence; push.

Builder rules (inline in every brief): stage explicit paths only; own only your wave's files; typecheck+tests before claiming done; no new native deps; no network calls in tests.
