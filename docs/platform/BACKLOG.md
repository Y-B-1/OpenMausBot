# Atrium Backlog — owner mandate of 2026-08-17 (autonomous loop charter)

Owner directive: build non-stop (audits + features), do NOT return for
decisions; feature-complete single-org product ("one-stop shop for my own
organization"); defer multi-org tenancy. This file is the loop's work queue.
Update it every iteration; mark DONE with commit hashes.

## Standing decisions (from this mandate)

- **Base stays ours.** Buzz web exists but is inseparable from its Nostr
  protocol + Rust relay stack; adopting it discards our tested TS spine.
  Mine Buzz for UI/protocol patterns only. (Assessment in §Buzz notes.)
- **Single org.** Keep the tenancy seam in code but stop surfacing it;
  everything is org "acme". Multi-org later.
- **Runtime targets:** Claude Managed Agents + Claude Agent SDK as the work
  engine; option to add Azure Foundry keys for other-model access via an
  agnostic path. Needs owner-supplied keys (ANTHROPIC_API_KEY now; Foundry
  endpoint+key later). Build scaffolding so keys drop in.

## Epics

### E1 — Four rooms, seamless
- [x] (044c8d9) DM surface: first-class "Direct messages" section (1 human + 1 agent
      channels auto-created per agent); DM quality ≥ upstream OpenMausBot
      chat (port its streaming/composer polish where better).
- [x] (pending4) Cross-room flow: chat header 'Promote to goal' pre-selects the channel; inbox/question cards deep-link 'Open the room this came from'.
- [ ] Group chat polish: typing/turn indicators, agent status chips.
- [x] (312def4) Task board view (Board nav): todo/doing/needs-you/done columns from goals+pipelines, cards deep-link.

### E2 — Connectors (the owner's memory vision)
- [x] (044c8d9) Connector registry: record = {provider (microsoft365, sharepoint,
      onedrive, teams, outlook, confluence, jira, databricks, github, ...),
      kind: memory | agent, status: connected|disconnected, accessLevel:
      read_only | write_no_delete, tools: [{name, enabled}], scope: org |
      team | user}.
- [x] (044c8d9) Memory connectors are READ-ONLY ingest: synced items become memory
      entries with source=connector, trustTier=org_ratified automatically
      (systems of record need no human approval — approval queue is only for
      what AGENTS claim to have learned).
- [x] (044c8d9) Agent connectors: per-tool toggles; write_no_delete enforced
      server-side like files policy.
- [ ] Admin UI: connect/disconnect, configure tools, assign visibility
      (which teams/users see which connector).
- [ ] Real integrations behind a `ConnectorProvider` seam; mock provider
      first; M365 Graph + Atlassian next (need owner OAuth app creds — 
      collect via /wizard when reached).

### E3 — Admin, roles, teams (single-org RBAC)
- [x] (044c8d9) Roles: admin | member. First user = admin; admin can promote.
- [x] (044c8d9) Teams: create teams, assign members; team-scoped visibility for
      connectors, memory (team scope), channels.
- [ ] Org-memory partitioning: admin controls which teams see which memory
      partitions (department walls).
- [ ] Admin view: users, roles, teams, connector grants, memory partitions,
      audit log browser.

### E4 — Memory, explained and segmented
- [x] (044c8d9) UI segmentation: Personal / Team / Organization tabs; provenance
      shown (agent-proposed vs connector-synced vs human-written).
- [x] (044c8d9) Review queue applies ONLY to agent proposals (make this visually
      obvious — this confused the owner).
- [x] (05b8360) Memory search: `memory_search` agent tool + team walls (passesTeamWall/searchMemory in memory-gates).

### E5 — Engine room: Managed Agents + Agent SDK + Foundry option
- [ ] `managed` driver: run a work agent as a CMA session (agents.create
      once, sessions per task, budgets = our guardrails, outcomes = our
      goals). Blocked on ANTHROPIC_API_KEY.
- [ ] `agent-sdk` runner: local worker executing Claude Agent SDK sessions
      for repo work; events mirrored into channels.
- [ ] `foundry` driver (@anthropic-ai/foundry-sdk) + generic OpenAI-compat
      driver for Grok/DeepSeek-class models. Key entry UI in Admin →
      Providers (keys stored server-side .env, never client).
- [x] (fc13a94) Provider status page (Admin → Model providers): key presence, driver gating, .env.example + loader. Model-picker constraint still open.

### E6 — type.com learnings beyond shared brain
- [ ] Spaces as bundles: a Space = channels + connectors + skills + memory
      partition an agent inherits on entry (our `space` field, promoted).
- [ ] Import-from-local onboarding: ingest CLAUDE.md/skills from a repo to
      seed agent configs (we have YAML export; add import).
- [ ] Self-review loop: agents grade own outputs → verdicts written back as
      memory proposals.
- [ ] Doc surface: artifacts produced by agents browsable per Space.

### E7 — Demo & evidence (owner sees everything)
- [ ] Rich seed: admin + 2 members, 2 teams, DMs, group channel, running +
      done goals, gated pipeline, connectors (M365 connected w/ synced
      memory, Jira disconnected), org/team/personal memory, costs.
- [ ] Screenshot set per view, light+dark, committed.
- [ ] Live walkthrough available at any time via `pnpm demo`.

## Buzz notes (owner's questions answered — keep for reference)

Web version: YES (React/TanStack/nostr-tools) but it speaks the Nostr
protocol to a Rust relay (Postgres+Redis). Using it requires adopting their
entire backend; not a shortcut for us — decision: stay on our stack.
Owner-heard limitations, verified against repo: partially true. Their
buzz-agent is deliberately minimal — one flat loop per agent (no sub-agent
hierarchy/orchestrator like Claude Code; up to 8 independent sessions per
process); context overflow handled by lossy self-summarization; in a group
channel each listening agent independently spends tokens on the same
conversation (the "costs multiply" complaint). Not "broken", but the
orchestration depth we want lives above their design, same as above ours.

## Loop protocol

Each iteration: pick highest-value unchecked item → design lightly → build
with tests → screenshot if visual → commit+push → tick the box with hash →
append discoveries here → repeat. Never block on the owner; if an item needs
owner input (keys/OAuth), scaffold around it, note it in §Blocked, move on.

### Blocked on owner
- ANTHROPIC_API_KEY (E5 real runs)  - Foundry endpoint+key (E5 option)
- M365 / Atlassian OAuth app credentials (E2 real sync)
