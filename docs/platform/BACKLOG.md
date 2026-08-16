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
- [x] (0472fa3) Cross-room flow: chat header 'Promote to goal' pre-selects the channel; inbox/question cards deep-link 'Open the room this came from'.
- [x] (f3f4271) Group chat polish: typing/turn indicators (PendingBubble), roster presence chips (responding…/idle from pendingTurns).
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
- [x] (95dc097) Admin UI: connect/disconnect, configure tools, assign visibility
      (which teams/users see which connector) — visibility now ENFORCED
      server-side: /api/state sends members only org- or own-team-scoped
      connectors; admins receive all.
- [ ] Real integrations behind a `ConnectorProvider` seam; mock provider
      first; M365 Graph + Atlassian next (need owner OAuth app creds — 
      collect via /wizard when reached).

### E3 — Admin, roles, teams (single-org RBAC)
- [x] (044c8d9) Roles: admin | member. First user = admin; admin can promote.
- [x] (044c8d9) Teams: create teams, assign members; team-scoped visibility for
      connectors, memory (team scope), channels.
- [x] (d7ebafb) Org-memory partitioning: admin controls which teams see which memory
      partitions (department walls) — connector re-scope (POST /api/connectors/:id
      scope?/teamId?, future syncs) + server-side memory walls in /api/state.
- [ ] Admin view: users, roles, teams, connector grants, memory partitions,
      audit log browser.

### E4 — Memory, explained and segmented
- [x] (044c8d9) UI segmentation: Personal / Team / Organization tabs; provenance
      shown (agent-proposed vs connector-synced vs human-written).
- [x] (044c8d9) Review queue applies ONLY to agent proposals (make this visually
      obvious — this confused the owner).
- [x] (05b8360) Memory search: `memory_search` agent tool + team walls (passesTeamWall/searchMemory in memory-gates).
- [x] (60b9b4f) Refined segmentation UI: per-category sections within scope tabs (fact/preference/procedure/episode/glossary/lesson with labels + one-line explanations + counts, newest first), filters row (search, source chips, per-team chips), stat-mini strip, tightened MemoryCard meta line; "lesson" added to MemoryKind (80b75c1).

### E5 — Engine room: Managed Agents + Agent SDK + Foundry option
- [x] (08d2a83) `managed` driver SCAFFOLD: CMA agent-per-Atrium-agent cache, session-per-turn with initial_events + $5 budget cap, event polling to idle. Live validation still blocked on ANTHROPIC_API_KEY.
- [ ] `agent-sdk` runner: local worker executing Claude Agent SDK sessions
      for repo work; events mirrored into channels.
- [x] (98908a3) `foundry` driver (AnthropicDriver over the Foundry Messages
      endpoint) + generic OpenAI-compat driver (chat-completions loop,
      function-calling tools, 10-turn cap) for Grok/DeepSeek-class models.
      Key-gated factories wired into driverFor; live validation still
      blocked on owner keys.
- [x] (fc13a94) Provider status page (Admin → Model providers): key presence, driver gating, .env.example + loader. Model-picker constraint still open.

### E6 — type.com learnings beyond shared brain
- [x] (77fc4f4) Spaces as bundles (lite): sidebar space heading opens a
      SpaceView bundle page — channels, viewer-visible connectors, team-shelf
      memory. Agent-inherits-on-entry (skills, auto-context) still open.
- [x] (707dbc4) Import-from-local onboarding: /api/import accepts {claudeMd}
      and seeds a mock "Repo Assistant" agent from the doc head (first 2000
      chars as persona). Skills ingestion still open if ever needed.
- [x] (54196b5) Self-review loop: GoalCompleted → orchestrator posts a review
      prompt; agent proposes a lesson to memory (review queue).
- [x] (f943bdd) Doc surface: Files view (GET /api/files from FileWritten
      replay, grouped by agent).

### E7 — Demo & evidence (owner sees everything)
- [x] (76b99fc) Rich seed via `pnpm demo` (REST against a running relay,
      idempotent): Yosri admin + Sara member, Engineering/Finance teams,
      #product chat + pending @Dev question, DM, SharePoint org memory +
      Confluence team memory synced, Jira agent connector, Outlook
      disconnected, done + halted goals, gated pipeline.
- [x] (218c0d7) Screenshot set per view, light+dark, committed (w8 gallery:
      board, admin-connectors, memory-org, inbox, files, channel with live
      presence chip; regenerate any time with `scripts/screenshots.mjs`).
- [x] (402350e) Deployment README: plain-language install/run/backup/keys/
      demo/health-gate quickstart in platform/README.md.
- [x] (db628a7) PWA-lite: installable manifest + theme-color; hidden-tab
      desktop notifications for inbox items/questions (opt-in from Inbox,
      no service worker — push proper needs infra we don't have).
- [x] (76b99fc) Live walkthrough available at any time via `pnpm demo`
      (requires `pnpm start` first; friendly error otherwise).
- [x] (7092602) Cohesive story seed: `pnpm demo` now tells one "Acme Digital"
      story across EVERY surface — 4 humans / 3 teams / 4 agents / 7 rooms +
      DMs, every mock behavior triggered (plan card, approval flow with one
      approved + one pending compute, egress allow+deny, files, remember →
      accept/pending/quarantine → recall, open inbox item, pending + answered
      questions), 3 done + 1 halted goal, 1 done + 2 gated pipeline runs,
      2 routines, connector-kind memory diversity; hard-verified end-to-end
      by scripts/demo-verify.mjs (28 PASS asserts on an ephemeral stack).

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
