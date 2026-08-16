# Atrium prototype — design spec (v1, 2026-08-16)

Decisions made autonomously under the owner's "go, don't ask" ruling; each is
reversible and logged here.

## Goal (done_when)

A runnable web app demonstrating the thin end-to-end slice of the Atrium
architecture (VISION.md): channels where humans and agents coexist, one
append-only event log with scoped fan-out, tiered memory with a review queue,
tool approvals, per-agent model policy, and a sandboxed "computer" behind a
SandboxProvider interface. `pnpm -C platform check` green (typecheck + tests)
and a screenshot of the running UI.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Working name **Atrium**; prototype lives in `platform/` as a self-contained pnpm workspace package (`platform/server`, `platform/web`, `platform/shared`) | Full-revamp authority without destabilizing upstream app; clean deletion boundary |
| D2 | Storage: **append-only NDJSON event log per org + in-memory projections** rebuilt on boot | Zero native deps; mirrors the event-log-is-the-product doctrine; DB is a later swap behind `EventStore` |
| D3 | Transport: **WebSocket** (`ws` pkg) with per-connection channel-scoped subscriptions; REST for commands | Fixes upstream's SSE-broadcast-to-all leak; Buzz's access-check-before-subscribe ported |
| D4 | Tenancy: single org ("acme") resolved through one `resolveOrg(host)` seam, fail-closed | The Buzz Step-0 pattern present from day one; multi-org = implement the map |
| D5 | Identity: **auth-lite** — named users with server-issued session tokens (no passwords in prototype); agents are first-class members with `kind:"agent"` | Enterprise SSO wraps this later; agents ≠ humans in the roster (auditable separately) |
| D6 | Agents: `AgentDriver` interface with two impls — **`mock`** (deterministic, offline demo) and **`anthropic`** (real Claude via `ANTHROPIC_API_KEY`, Haiku-class default) | Demoable with zero keys; real when a key exists; per-agent `model_policy` on the record |
| D7 | Memory: `MemoryEntry` per tiered-memory.md §3.1 (scope org/space/personal, trust tiers, provenance, supersede-not-delete) with agent-**proposed** entries and a human review queue; injected into prompts as labeled DATA blocks | The research design, thin-sliced |
| D8 | Approvals: agent tool calls emit `approval.requested` events; channel members approve/deny; auto-allow list per agent | Upstream approval-card lifecycle, re-homed on the event log |
| D9 | Sandbox: `SandboxProvider` interface (`create/exec/writeFile/readFile/destroy`); prototype impl = **local subprocess in a scratch dir with a command allowlist and no network**, every exec audited | The seam is the deliverable; E2B/Firecracker are impls later |
| D10 | Data-not-directives: all memory/roster/peer content enters prompts wrapped in delimited reference blocks with an explicit non-instruction notice | Red-team injection gap |
| D11 | UI: React 19 + Vite, no component library, tokens-based light/dark; views: channel list, chat (agents streaming), memory review queue, approvals inline, agent computer log panel | Matches repo stack; small surface |
| D12 | Tests: Vitest on server projections/routing/memory-gates; UI smoke via Playwright screenshot script | Evidence-gated DONE |

## Non-goals (prototype)

Real multi-org billing, SSO/SCIM, real Firecracker/E2B calls, Composio,
voice, mobile, plan-then-execute data engine (stub interface only), skill
registry (schema only).

## Event kinds (integer-extensible, Buzz-style)

1 message · 2 reaction · 10 channel.created · 11 member.added ·
20 agent.turn.started · 21 agent.stream.delta (ephemeral) · 22 agent.turn.completed ·
30 approval.requested · 31 approval.resolved ·
40 memory.proposed · 41 memory.accepted · 42 memory.rejected ·
50 sandbox.exec (audit) · 60 audit.note

Pipeline per event: authenticate → membership check → append → fan-out to
authorized subscribers only → projections fold → side-effects (agent
dispatch) fire-and-forget.
