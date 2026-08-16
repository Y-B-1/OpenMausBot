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
NEXT: charge:design spec (needs owner alignment interview) → charge:plan →
web prototype (thin slice: multi-tenant relay, channels, 2–3 live agents,
tiered memory + review queue, one sandboxed computer, approvals).
Branch: `claude/hybrid-ai-platform-planning-upe28l` (all work lands here).

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
