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
WAVE 8 (ralph run, 2026-08-17): DEPLOYABLE BAR MET — verify-all.sh green:
59 vitest, prod build, one-command smoke (relay serves web/dist, `pnpm
start`), scrypt passwords + persisted sessions (restart-safe), /api/import,
spaces grouping, /api/audit + Admin Audit tab, and scripts/e2e-demo.mjs — a
14-assert full-surface browser walkthrough (chat/DM/inbox-question/goal/
board/pipeline-gate/connector-sync→memory/promote/costs/audit) — E2E OK.
Ralph harness state in repo-root loop-state.json (git-excluded).
WAVE 8 passes 4-8 (loop iters 9-13, all harness-verified): presence chips +
reload-safe openTurns, self-review→memory loop, Files surface, server-side
team walls (memory + connector visibility), connector re-partitioning,
foundry + openai_compat driver IMPLEMENTATIONS (key-gated), `pnpm demo`
idempotent seeder, claudeMd import onboarding, deployment README, PWA-lite
manifest + hidden-tab desktop notifications, Space bundle page, chat polish
(hover timestamps, scroll pinning), 12 w8 screenshots. 70 vitest + full e2e
green (verify-all.sh). Unblocked backlog EXHAUSTED.
BLOCKED ON OWNER: ANTHROPIC_API_KEY (live anthropic/managed validation +
agent-sdk runner), Foundry keys, M365/Atlassian OAuth creds (real syncs).
Loop parked on long heartbeat watching platform/.env for keys.

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
- 2026-08-17 (owner): Foundry is NOT required after all (reversed same-day).
  Owner wants a plain-language comparison first: Anthropic direct (incl.
  Managed Agents) vs Azure Foundry, and a multi-model fleet option. Decision
  now OPEN — default leaning: Anthropic API direct; Managed Agents becomes a
  candidate to replace our runner layer; driver seam keeps other models
  (Grok/DeepSeek) possible for chat/worker agents.
- 2026-08-17: architecture Q&A → `docs/platform/ARCHITECTURE-QA.md` —
  two agent classes (chat = thin harness on Foundry driver; work = Claude
  Agent SDK sessions on runners), three sandbox tiers (Local / ephemeral
  Azure Container Apps / persistent Azure VM runner pool with outbound-only
  work queue + NSG egress from environment allowlist), concurrency only via
  decomposition (parallel pipeline step + worktree isolation; channel stays
  single-in-flight).

## Lessons (one line each)

1. Cloud sessions cannot write `~/.claude/CLAUDE.md` or install hooks —
   repo-versioned copies are the durable home for doctrine.
2. Egress proxy blocks type.com, blog.cloudflare.com, Wayback — research via
   search snippets + GitHub primary sources instead.
