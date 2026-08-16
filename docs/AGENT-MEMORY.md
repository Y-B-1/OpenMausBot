# Agent memory — OpenMausBot platform fork

> **What this is.** The repo-versioned memory and single continuation point:
> a new session reads this file (CLAUDE.md points here) and picks up cold.
> **Update discipline:** same commit as the work it describes. **Prune:**
> ≤200 lines; archive to `docs/agent-memory/`, never delete.

## Current state — 2026-08-16

Fork of OpenMausBot being revamped into a hybrid next-gen platform
(Grok Bot × Block Buzz × Type.com × PromptQL/OpenClaw/Hermes lessons).
Research phase complete-ish: seven briefings in `docs/platform/research/`
(Grok Bot and Buzz web briefings may still be landing). Buzz cloned read-only
at `/workspace/block/buzz`; charge skills installed at `~/.claude/skills`
(source: github.com/Y-B-1/charge). Next: synthesis + product vision →
charge:design spec → plan → web-app prototype.
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
