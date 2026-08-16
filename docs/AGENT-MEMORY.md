# Agent memory — OpenMausBot platform fork

> **What this is.** The repo-versioned memory and single continuation point:
> a new session reads this file (CLAUDE.md points here) and picks up cold.
> **Update discipline:** same commit as the work it describes. **Prune:**
> ≤200 lines; archive to `docs/agent-memory/`, never delete.

## Current state — 2026-08-16 (batch 2 close)

Research COMPLETE: 10 briefings in `docs/platform/research/`, all red-teamed
(`docs/platform/RED-TEAM.md`, 9 fact-check agents, 4 refuted claims patched
in place). Synthesis in `docs/platform/VISION.md` (working name: Atrium);
presentation artifact published (URL in VISION.md). Buzz cloned read-only at
`/workspace/block/buzz`; charge skills at `~/.claude/skills`.
PROTOTYPE SHIPPED (batch 3, owner-authorized autonomous run): `platform/`
workspace — event-log relay (WS scoped fan-out, fail-closed tenancy seam),
agent drivers (mock + anthropic), per-channel dispatcher, tiered memory with
review queue + quarantine gates, LocalSandbox with approvals + audit, React
web UI. 21 tests green; e2e screenshot evidence `platform/web/screenshot.png`.
Design/plan: docs/platform/DESIGN.md, PLAN.md (decisions logged as D1–D12).
NEXT: owner feedback on prototype → widen slices (real E2B SandboxProvider,
multi-org, SSO wrap, plan-then-execute stub, Composio connectors).
Branch: `claude/hybrid-ai-platform-planning-upe28l` (all work lands here).
2026-08-16 (local session): work moved to owner's Mac at
`~/Documents/Claude/AgentOS/OpenMausBot`; buzz reference clone alongside.
Postma AgentOS video studied → `docs/platform/research/agentos-video-study.md`
(gap list + BINDING design direction §4: UI = type.com × OpenMausBot cross).
WAVE 6 SHIPPED (this session): the full gap list is implemented in
`platform/` — inbox + blocking ask_user (kinds 80-83), goal loops with hard
guardrails (spend/session/wall-clock/stuck, kinds 90-95), pipeline templates
with approval gates (kinds 100-104), per-agent egress allowlist (fail-closed)
+ policy files (write/read, no delete, kinds 110-111), per-turn cost ledger
(kind 120), YAML export (`/api/export`). UI fully redesigned to the §4 cross
(light=type.com, dark=OMB stack, indigo accent, serif titles, OMB motion) with
new sidebar IA: Inbox/Channels/Goals/Pipelines/Costs/Memory/Computer.
Evidence: 42 tests green; live e2e exercised (question answered → goals
done+halted → pipeline gate approved → done); screenshots
`platform/web/screenshot-w6-*-{light,dark}.png`. Dev needs Node 22
(`nvm use 22`) for `--experimental-strip-types`.
NEXT: real Anthropic-driver trial of goal/pipeline prompts; then E2B
SandboxProvider, multi-org, SSO, Composio connectors.

## Baselines

Upstream app: React 19 + Vite + Electron + node:http harness server; Vitest
suite (~30 files) green upstream; no auth/tenancy anywhere (see codebase map).

## Open items

- Synthesis doc + product vision (docs/platform/).
- Design spec via charge:design; red-teamed plan via charge:plan.
- Web prototype (multi-tenant channels, humans + agents, sandbox + model
  routing per research recommendations).
- Hooks/settings from claude-project-starter NOT installed in cloud session
  (permission classifier blocks executable hook writes) — owner installs
  locally from `docs/GLOBAL-CLAUDE.md` companion starter or equitihub copy.

## Binding decisions

- 2026-08-16 (owner): full-revamp authority on this fork; take from upstream
  only what the platform needs.
- 2026-08-16 (owner): personal project first (possible enterprise sale, e.g.
  Equiti later) — design for multi-tenant + self-host path from day one.
- 2026-08-16 (owner): prototype is a WEB app.
- 2026-08-16 (owner): autonomous ralph-loop mode while owner is offline;
  minimal interruptions; commit and push continuously.

## Lessons (one line each)

1. Cloud sessions cannot write `~/.claude/CLAUDE.md` or install hooks —
   repo-versioned copies are the durable home for doctrine.
2. Egress proxy blocks type.com, blog.cloudflare.com, Wayback — research via
   search snippets + GitHub primary sources instead.
