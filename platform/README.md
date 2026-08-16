# Atrium — prototype

The thin end-to-end slice of the platform described in `docs/platform/VISION.md`
(design: `docs/platform/DESIGN.md`, plan: `docs/platform/PLAN.md`): channels
where humans and agents coexist on one append-only event log, tiered memory
with a human review queue, tool approvals, and sandboxed agent computers
behind a `SandboxProvider` seam.

## Run it

```bash
pnpm install
pnpm -C platform seed       # populate the acme demo workspace (recommended)
pnpm -C platform dev        # relay server on :8900
pnpm -C platform dev:web    # web UI on :8901
```

The seed creates a full demo: 3 channels (#general, #finance, #eng), agents
Scout/Quill/Ledger, seeded conversations, memory across all four trust tiers
(including one awaiting review and one quarantined injection attempt), a
resolved and a pending approval with sandbox audit, and a scheduled routine.
Log in as `Yosri`. Try: `Ledger, show me the Q3 revenue numbers` in #finance
(query-plan card), approve the pending card in #eng, review the memory queue,
and hit Run now on the Weekly eng digest routine.

Open http://localhost:8901 — log in with any name, create a channel, add a
mock agent, and talk to it: `@Scout please compute something` triggers a
sandboxed tool call gated by an approval card; `@Scout remember …` files a
memory proposal into the review queue (Memory panel).

Set `ANTHROPIC_API_KEY` and add an agent with driver `anthropic` for real
Claude turns (model from the agent's model policy, default Haiku-class).

## Layout

- `shared/contracts.ts` — event kinds (integer-extensible), records, wire types
- `server/` — relay (node:http + ws): auth-lite sessions, fail-closed
  `resolveOrg` tenancy seam, membership-checked channel-scoped fan-out,
  NDJSON event store + projections rebuilt from the log
- `server/agents/` — driver SPI (mock + Anthropic), per-channel single-in-flight
  dispatcher with queue/batch, memory gates (quarantine → agent_proposed →
  human_confirmed; data-not-directives injection), `LocalSandbox`
  (allowlisted argv, no shell, audited)
- `web/` — React 19 + Vite UI: chat with streaming + approval cards, memory
  review queue and tier browser, per-agent computer audit panel

## Checks

```bash
pnpm -C platform check      # tsc --noEmit + vitest (21 tests)
```

Prototype non-goals (see DESIGN.md): real multi-org, SSO, E2B/Firecracker
backends, Composio, plan-then-execute engine. Each has a seam waiting.
