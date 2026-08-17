# UPSTREAM-INTEGRATION — port plan: platform/ features into the upstream OpenMausBot app

> Binding pivot (docs/AGENT-MEMORY.md, 2026-08-18): the upstream app at repo
> root (`src/`, `server/`, `electron/`) is the product base, kept exactly
> as-is — look, assets, agent format, everything. Every feature built in
> `platform/` is ADDED INTO it following upstream patterns. `platform/`
> stays as reference implementation + test bed. This file is the pass-by-pass
> port plan; each pass is sized for one focused agent session.

All paths are repo-relative to `/Users/yusri/Documents/Claude/AgentOS/OpenMausBot`.

---

## 1. Upstream map (what we are extending)

### 1.1 App shell & navigation

- `src/App.tsx` (111 lines) — the whole shell. `Shell()` renders `<Sidebar/>`
  then ONE main surface chosen by `state.activeView` (`"chat" | "routines"`)
  plus the selected bot/group; overlay panels (`SettingsPanel`,
  `ComputerPanel`, `SettingsModal`, `PluginsPanel`) are conditionally
  appended. **A new full-page view = a new `activeView` value + a branch
  here** (copy the `RoutinesPage` branch).
- `src/state/store.tsx` (1246 lines) — the ONLY state container: a pure
  reducer + typed `Action` union + a wrapped `dispatch` that does HTTP
  side-effects, folding the single SSE stream (`GET /api/events`) into
  state. New features add: state fields, actions, reducer cases, an
  HTTP call in the dispatch wrapper, and an SSE-fold case. No other state
  library exists.
- `src/components/Sidebar.tsx` (664 lines) — bot/group list + a **Footer**
  block (~line 617) where `Routines`, `Plugins`, `Settings` buttons live.
  New sidebar destinations are additional footer buttons dispatching
  `{ type: "showX" }`, with the exact `cn(...)`/lucide-icon markup of the
  Routines button (incl. the unread-dot pattern).
- Component conventions: function components, Tailwind v4 utility classes
  against theme tokens (`bg-app`, `bg-raised`, `text-ink`, `text-accent`…),
  lucide-react icons, `cn()` from `src/lib/cn.ts`, `SettingsPrimitives.tsx`
  for form rows, `OptionCard.tsx`/`ApprovalCard.tsx` for in-chat asks.

### 1.2 Agent format

- Agents are **bots**: `BotRecord` in `server/store.ts` (mirrored as `Bot`
  in `src/state/store.tsx`) — id, active `threadId`, `tasks[]` (one provider
  session per task), name/title/description, `MausColor` + mascot
  expression, `modelSelection: { instanceId, model }`, `resumeCursors`
  (provider-native continuation per instance), `computer` target,
  `autoApprove`/`alwaysAllow`, `chiefOfStaff` flag.
- On disk: `~/.openmausbot/` (`DATA_DIR`, overridable via `OMB_DATA_DIR`) —
  `bots.json`, `messages-<threadId>.json` (folded transcript),
  `events/<threadId>.ndjson` (canonical raw event log per thread),
  `config.json` (keys + `instances` map).
- Providers: driver plugins in `server/drivers/` (`claude`, `codex`, `grok`,
  `grokagent`, `antigravity`, `boxagent`, `native`, `builtIn`, `acp/`), each
  exporting a `ProviderDriver` (contract in `server/contracts.ts`).
  `server/harness/registry.ts` turns `config.instances` into live instances
  (unknown/broken config → "shadow" instance, never a startup failure);
  `server/harness/bus.ts` is the fan-in `EventBus` that stamps
  `providerInstanceId`, tees NDJSON, and feeds SSE + the message folder.
  Keys/config: `server/config.ts` → `GET/PATCH /api/config`, UI in
  `src/components/ApiKeys.tsx` / `EngineSetup.tsx` / `ModelPicker.tsx`.

### 1.3 Harness server

- `server/index.ts` (1647 lines) — plain `node:http`, hand-rolled routing
  (`if (method === X && path === Y)` + regex matches), `json()` helper.
  Surface: `/api/events` (SSE, one stream for everything, 25s keepalive),
  `/api/bots` CRUD + per-bot POST verbs (send, answer, interrupt, task ops),
  `/api/groups` (rooms/DM channels), `/api/routines` (delegates to
  `server/routines.ts`), `/api/config`, `/api/instances`, `/api/health`,
  `/api/connectors` (Composio), `/api/tts/*`, box/local-computer routes,
  static serving of `web` build. Internal agent-to-agent:
  `/api/internal/agents`, `/api/internal/ask-bot`.
- Streaming: driver adapter events → `EventBus` → server folds them into
  `messages-<threadId>.json` AND pushes SSE patches; the client never talks
  to providers directly.
- Persistence: JSON files via `writeFileAtomic` (`server/atomic.ts`).
  **No auth, no tenancy, no event log as source of truth** — folded state
  files are canonical, NDJSON is a debug tee.
- Tests: Vitest, colocated `*.test.ts` next to sources (~30 files), fakes in
  `server/testing/` (`fake-driver.ts`, fake CLIs). `pnpm test` runs all.

### 1.4 Design system

- `src/styles.css` — Tailwind v4 `@theme` tokens: Grok-dark palette
  (`--color-app #070707`, `--color-panel #111111`, `--color-raised #2f2f2f`,
  accent `#1084fe`, success/danger/warning), Inter, small radii, keyframe
  animations (`panel-in`, `pop-in`, `msg-in`, `shimmer`). Dark-only.
- No component library; hand-built primitives (`SettingsPrimitives.tsx`,
  `OptionCard.tsx`, `Avatar.tsx`/mascot in `src/lib/mascot.ts` +
  `public/`/`build/` assets). **Do not restyle; new views reuse tokens.**

### 1.5 Extension seams (the pattern to copy, per kind of addition)

| Addition | Copy exactly | Files touched |
|---|---|---|
| Server feature module | `server/routines.ts` (own types, own JSON file in `DATA_DIR`, pure functions + a small manager, colocated `routines.test.ts`) | new `server/<feature>.ts` + `.test.ts`, route block in `server/index.ts` |
| Server routes | routines block in `server/index.ts` (~1038-1072): GET list / POST create / PATCH / DELETE + verb POSTs, SSE patch events on change | `server/index.ts` (append-only inside the router) |
| Full-page view | `RoutinesPage.tsx` + `activeView` in store + branch in `App.tsx` + footer button in `Sidebar.tsx` | 4 files, all additive |
| Client state | routines slice in `src/state/store.tsx`: `routinesHydrated`/`routinePatched`/... actions, SSE fold cases, HTTP in dispatch wrapper | `src/state/store.tsx` |
| In-chat interactive card | `OptionCardData` + `OptionCard.tsx` / `ApprovalCard.tsx` / `PendingApproval.tsx` (`answerCard`/`decideRequest` actions) | reuse as-is for questions/gates |
| Overlay panel | `PluginsPanel.tsx` (+ `pluginsOpen` flag) | for smaller surfaces (e.g. Costs, Files) |
| New provider driver | `server/drivers/grok.ts` (thin HTTP driver) or `claude.ts` (CLI driver); register in the driver list in `server/index.ts` | 1 new file + registration |

---

## 2. What we are porting (platform/ inventory)

Prototype: event-log relay `platform/server/relay.ts` (872 — all routes +
WS fan-out + auth), `store.ts` (344 — append-only event log), shared
`platform/shared/contracts.ts` (393 — records + `EventKind` 1-142), agents
in `platform/server/agents/` (dispatcher 436, memory-gates 124, engines 190,
drivers mock/anthropic/openai-compat/foundry/managed, sandbox 92),
`connectors.ts`, `yaml.ts` (export/import), `seed.ts`; UI is one file
`platform/web/src/app.tsx` (1789) + `store.tsx` (610). 70 vitest green
(`relay/store/wave5-8/agents` test files) + `scripts/e2e-demo.mjs`.

Feature → platform source (event kinds):
- Inbox + blocking questions (80-83): relay.ts + dispatcher.ts (`ask_user`), UI Inbox view in app.tsx
- Goals + guardrails (90-95): relay.ts goal loop + `GoalRecord`/`GoalGuardrails` in contracts.ts
- Pipelines + approval gates (100-104): relay.ts (`/api/templates`, `/api/pipelines`) + `TemplateRecord`/`PipelineRun`
- Board: derived kanban over goals/pipelines in app.tsx
- Memory tiers/team walls/review queue (40-42): memory-gates.ts + `MemoryEntry` (`TrustTier`, scopes)
- Connectors registry + mock sync (140-142): connectors.ts + `/api/connectors*`
- Teams/roles/admin + auth (130-132): relay.ts (`/api/login` scrypt sessions, `/api/teams`, role checks)
- Cost ledger (120): `TurnCost` per turn in dispatcher.ts; Costs view
- Files + egress policy (110-111): sandbox.ts + `/api/files`
- Audit (60-61): `/api/audit` projection over the event log
- DMs/spaces/presence: `/api/dm`, spaces grouping, presence chips in web store
- Export/import: yaml.ts, `/api/export`, `/api/import` (claudeMd onboarding)

**Persistence decision (risk #1): ADAPTER, not replace.** Upstream's
canonical state = folded JSON files; platform's = append-only event log.
We keep upstream's model untouched and port each feature as an upstream-style
module (`server/<feature>.ts` + own JSON file + SSE patches). Where a
feature genuinely needs an ordered history (audit, costs), reuse upstream's
existing NDJSON tee (`server/harness/bus.ts` publish) plus a small
append-only `audit.ndjson` in `DATA_DIR` — never restructure upstream's
store. Platform `EventKind` numbers become internal to the ported modules'
records, not a global log.

---

## 3. Buzz mine (reference clone `/Users/yusri/Documents/Claude/AgentOS/buzz`)

Orientation: `web/src` is nearly empty — **the real React/TS app is
`desktop/src`** (Tauri + React + TanStack Query + shadcn-style
`shared/ui`); `admin-web/src` is a tiny standalone admin SPA. Buzz has NO
kanban board, no cost ledger, no first-class goals — those stay ours.
Rust crates = patterns only; desktop/admin-web TS = portable.

Ranked steals (path → what → PORT vs PATTERN → serves):

1. **Workflow schema + approval-gate executor** — `crates/buzz-workflow/src/schema.rs` (discriminated-union triggers/steps incl. `request_approval {from, message, timeout}`) and `executor.rs` (`StepResult::Suspended {approval_token}`, resume-from-step-index preserving the pre-approval `execution_trace`). PATTERN (transcribe schema to TS unions). → P4 pipelines; step `if:` + `timeout_secs` doubles as a guardrail hook for P2.
2. **Workflow/approval SQL shapes** — `schema/schema.sql:363–470`: `run_status` enum incl. `waiting_approval`, `workflow_approvals(token PK, approver_spec, expires_at…)` — a blocking question IS a token-addressed expiring approval row, resolvable uniformly from DM/webhook/UI. PATTERN. → P1 inbox questions, P4 gates.
3. **Workflow UI feature folder** — `desktop/src/features/workflows/` (21 files ~2.8k lines: `WorkflowFormBuilder.tsx`, `WorkflowStepCard.tsx`, `WorkflowRunTrace.tsx`, `WorkflowApprovalCard.tsx`, `hooks.ts`). PORT (swap data layer; restyle to upstream tokens). → P4 pipelines editor/trace UI.
4. **Inbox two-pane feature** — `desktop/src/features/home/` (`InboxListPane/DetailPane/MessageRow/FilterMenu` + `useHomeInboxReadState`, auto-selection, selection anchor, resizable split hooks). PORT. → P1 InboxPage.
5. **Hash-chained audit log** — `crates/buzz-audit/src/hash.rs` (SHA-256 chain w/ microsecond-truncated timestamps + presence-tagged fields), `action.rs` (closed action enum, one `as_str()` for hash+storage), DDL `schema/schema.sql:645–663`. PATTERN. → P9 audit (tamper-evident NDJSON chain), reusable for P8 costs.
6. **Kind-registry dispatch + loop prevention** — `ARCHITECTURE.md:109–320` + `crates/buzz-core/src/kind.rs`: integer-kind ranges, ephemeral range never stored, and the rule that workflow-execution kinds are EXCLUDED from re-triggering workflows (ARCHITECTURE.md:237–244). PATTERN. → validates platform's EventKind scheme; the no-retrigger rule is mandatory in P4 (pipeline events must not feed back into pipeline triggers or spam the inbox).
7. **Memory graph + owner gating** — `desktop/src/features/agent-memory/lib/buildMemoryGraph.ts` (pure tree-from-flat-list w/ orphans + dangling refs = review-queue signal, tested) + `ui/MemorySection.tsx`, `hooks.ts` (`undefined` = loading, not false). PORT lib / PATTERN ui. → P5 memory review queue.
8. **Admin SPA + harness catalog** — `admin-web/src/App.tsx` + `useResource.ts` (57-line fetch-state hook, zero-dep list→detail admin tables) and `desktop/src/features/settings/ui/harness*` (catalog/gallery/form logic split into tested pure `lib` files). PORT patterns. → P6 connectors registry UI, P7 AdminPage, P10 providers screen.

Convention worth adopting for our NEW upstream files: Buzz's
`features/<name>/{hooks, ui/, lib/}` habit of extracting pure logic into
small tested `lib/*.ts` files (mirrors what P3 does with `src/lib/board.ts`).

---

## 4. The passes

Rules for every pass: additive only (no upstream file rewritten, no
restyle); follow the seam table in §1.5; colocated vitest tests in
upstream style (use `server/testing/fake-driver.ts` where a turn is
needed); **exit criterion: `pnpm test` green, including the pass's new
tests**; commit per pass. The running dev stack (server 8799 / vite 5199 /
electron) must never be killed — vitest and `tsc` don't touch it.

### P0 — Baseline ✅ DONE (commit fd344b2)
Run `pnpm test` and `pnpm typecheck`; record counts + any pre-existing
failures at the top of this file. No code. Verify: exit 0 (or documented
pre-existing failures).
- **Recorded 2026-08-17 (planning session, run while the dev stack was
  live on 8799/5199):** `pnpm test` → 25 files passed / 10 failed;
  223 tests passed, 35 failed, 37 skipped (295). The failures are
  PRE-EXISTING (suspected interference from the running dev server /
  shared `~/.openmausbot` state — P0 must rerun on a scratch
  `OMB_DATA_DIR` with the stack idle, characterize each failing file,
  and pin the authoritative green/red list here). "Suite green" in later
  passes means: no NEW failures beyond the P0-pinned list.
- **Pinned 2026-08-17 (docs/platform/UPSTREAM-TEST-BASELINE.md):** under an
  isolated SHORT `OMB_DATA_DIR` the suite is FULLY GREEN — 35 files,
  287 passed / 8 skipped. All 35 planning-time failures were shared
  `~/.openmausbot` interference. Gotcha: the data dir path must be short
  (claude driver test binds a unix socket inside it; macOS sun_path ≈104B).

### P1 — Inbox + blocking questions (highest visibility) ✅ DONE
(commits 17f676d server, a9ea559 UI, screenshot+tick commit follows)
Shipped: `server/inbox.ts` + `inbox.test.ts` (7 tests); routes GET/POST
`/api/inbox`, POST `/api/inbox/:id/reply`, POST `/api/inbox/questions`,
POST `/api/inbox/questions/:id/answer`; live QUESTION asks mirrored into
the inbox on `request.opened` and settled on `request.resolved`; answering
a mirrored question from the Inbox calls `respondToRequest` and unblocks
the turn. UI: `InboxPage.tsx` two-pane (buzz home layout, upstream tokens),
store slice + SSE folds, Sidebar Inbox button with pending-count badge.
Suite 36 files green (baseline 35 + inbox), typecheck green. Evidence:
`platform/web/screenshot-p1-inbox.png` (isolated server on 8899 — the live
8799 process predates the routes and must not be restarted; same code,
seeded via curl).
- New `server/inbox.ts` + `inbox.test.ts` (port logic from
  `platform/server/relay.ts` inbox handlers + `InboxItem`/`QuestionRecord`
  from `platform/shared/contracts.ts`; storage: `inbox.json` via
  `writeFileAtomic`, pattern `server/routines.ts`).
- Routes in `server/index.ts`: GET/POST `/api/inbox`, POST
  `/api/inbox/:id/reply`, question ask/answer; SSE patch events.
  Wire `ask_user`-style provider questions: upstream ALREADY has live asks
  (`OptionCardData.requestId` + `decideRequest`) — the inbox is a cross-bot
  aggregation of those cards plus agent-posted items, not a new mechanism.
- UI: `src/components/InboxPage.tsx` (copy `RoutinesPage.tsx`), `activeView`
  `"inbox"`, App.tsx branch, Sidebar footer button with unread dot; answer
  UI reuses `OptionCard`.
- Verify: new vitest (post → appears; blocking question → answer resolves
  turn via fake driver) + full `pnpm test` green.

### P2 — Goals with guardrails ✅ DONE
(commits c3c4b78 server, 1269f60 UI, screenshot+tick commit follows)
Shipped: `server/goals.ts` + `goals.test.ts` (12 tests) — `GoalManager`
(RoutineManager pattern, `goals.json`, atomic writes): one detached task per
goal, one bot turn per session via the existing `startTurn`, criterion checked
off on a self-reported DONE line, guardrails enforced between sessions
(session cap, spend cap from the provider-reported `turn.completed` cost —
upstream DOES track per-turn cost, so spend is real, not a proxy — wall clock,
stuck detection); pause/resume/cancel (cancel interrupts the in-flight turn).
Routes GET/POST `/api/goals`, POST `/api/goals/:id/(pause|resume|cancel)`;
SSE `{kind:"goal"}`. Blocking questions raised mid-goal flow through the P1
inbox mirror with zero extra wiring. UI: `GoalsPage.tsx` two-pane (InboxPage
conventions), criteria checklist + guardrail meters + new-goal form; store
slice + SSE fold; Sidebar Goals button with running-count badge. Suite 37
files / 306 green, typecheck green. Evidence:
`platform/web/screenshot-p2-goals.png` — isolated server on 8899, LIVE claude
sessions actually ran ($0.28 real tracked spend) and the stuck guardrail
halted the loop at 3/3.
- New `server/goals.ts` + tests (port goal loop + `GoalGuardrails`
  spend/session/wall-clock/stuck halts from relay.ts; sessions run as bot
  turns through the existing registry/bus; storage `goals.json`).
- Routes: `/api/goals` CRUD + start/halt; SSE patches.
- UI: `GoalsPage.tsx` full-page view (activeView `"goals"`), criteria
  checklist + guardrail meters, sidebar button.
- Verify: vitest — criterion completion → done; each guardrail → halted.

### P3 — Board ✅ DONE
(commits 67098a5 selector, 6bac70c UI, screenshot+tick commit follows)
Shipped: `src/lib/board.ts` pure selector (+5 vitest) — columns Queued /
In progress / Waiting on human / Done / Halted computed from client state
only: busy bots' active tasks → In progress; goals running→In progress,
paused→Queued, done→Done, halted→Waiting (guardrail stop needs a human),
cancelled→Halted; pending inbox questions + open items → Waiting; routine
runs queued→Queued, running|waiting→In progress, completed→Done,
failed|cancelled|missed→Halted. `BoardPage.tsx` kanban (upstream tokens,
per-column counts, cards click through via existing dispatches: select /
showGoals / showInbox / showRoutines), activeView `"board"`, Sidebar entry.
No server changes. Suite 38 files / 311 green, typecheck green. Evidence:
`platform/web/screenshot-p3-board.png` (isolated 8899 server, seeded goals
across all statuses + inbox item + question; the running goal spawned a
REAL claude session, so a live busy-task card appears in In progress).
- Derived view, no new server state: `src/components/BoardPage.tsx`
  (activeView `"board"`) — kanban columns computed from bots' tasks, goals
  (P2) and pipelines (P4 — column appears then). Port layout from
  platform app.tsx board section, restyled to upstream tokens.
- Verify: component-level vitest (column derivation function extracted to
  `src/lib/board.ts` and unit-tested) + suite green.

### P4 — Pipelines with approval gates ✅ DONE
(commits: server + UI + this evidence commit)
Shipped: `server/pipelines.ts` + `pipelines.test.ts` (13 tests) —
`PipelineManager` (GoalManager pattern, `pipelines.json`): templates
(steps: title/prompt/botId/`gate:"approval"`), runs execute steps
sequentially as bot turns in per-step detached tasks, each step's last
assistant reply fed into the next step's prompt. A gated step suspends the
run BEFORE it executes: status `waiting_approval` + token-addressed expiring
approval (buzz `workflow_approvals` shape, 60m TTL, tick sweeps expiry →
rejected) mirrored into the P1 inbox with a synthetic
`threadId "pipeline:<runId>"` / `requestId <token>` pair, so answering the
inbox question forwards to approve/reject exactly like a live provider ask.
Reject/expiry cancel remaining steps; cancel interrupts the in-flight turn;
restart-safe (mid-turn step reruns, pending gates survive). No-retrigger
rule enforced: runtime events only ever advance in-flight steps, never
start runs (tested). Routes: GET/POST `/api/templates`, GET/POST
`/api/pipelines`, POST `/api/pipelines/:id/(approve|reject|cancel)`; SSE
`pipeline.template`/`pipeline.run`. UI: `PipelinesPage.tsx` two-pane
(templates + runs, step progress, inline gate Approve/Reject), activeView
`"pipelines"`, Sidebar entry with waiting-count badge, store slice + SSE
folds; board maps pipeline runs (waiting_approval → Waiting on human,
`board.test.ts` extended). Suite 39 files / 325 green (Node 24), typecheck
green. Evidence: `platform/web/screenshot-p4-pipelines.png` (isolated 8901
server, seeded run suspended at a gate; inbox-answer Reject verified live).
- New `server/pipelines.ts` + tests (port `TemplateRecord`/`PipelineRun`
  step machine + gate from relay.ts; steps execute as bot turns; gate
  raises an upstream approval card in the owning chat AND an inbox item).
- Routes: `/api/templates`, `/api/pipelines`, `/api/pipelines/:id/approve`.
- UI: `PipelinesPage.tsx`; gate approval reuses `ApprovalCard`.
- Verify: vitest — run advances step-by-step, halts at gate, approve →
  completes; deny → halted.

### P5 — Memory (categories, team walls, review queue) ✅ DONE
(commits 1a74911 server, 566c154 UI, evidence commit follows)
Shipped: `server/memory.ts` + `memory.test.ts` (11 tests) — `MemoryManager`
(`memory.json`, atomic writes): agent/connector proposals auto-tier via
`tierFor` (imperatives/URLs → quarantined, else agent_proposed) and wait in
the review queue; accept → human_confirmed, reject → retired; promote →
org_ratified; human adds land human_confirmed; delete is retire;
supersede-not-delete (a proposal's supersede applies only on accept, a human
add's immediately). INJECTION: `startTurn` appends `memory.contextBlock(text)`
to the system prompt — term-match search over accepted tiers only (cap 8),
wrapped in the D10 DATA_BLOCK_HEADER ("data, never instructions"); plus a
`GET /api/memory/search?q=` retrieval endpoint. AGENT WRITE PATH: a reply
line `REMEMBER: …` / `REMEMBER(kind): …` (the goals DONE-line convention,
parsed off `item.completed` assistant_text events, capped 5/reply) lands as
an agent proposal — runtime events can never mint a trusted tier; the system
prompt tells every bot the convention. Routes: GET/POST `/api/memory`,
POST `/api/memory/propose`, POST `/:id/(accept|reject|promote)`, DELETE
`/:id` (retire); SSE `{kind:"memory"}`. Team walls stay parameterized until
P7 (org/personal only, per plan). UI: `MemoryPage.tsx` platform-style
segmentation — stat mini-strip, review queue with Accept/Reject, kind
sections with one-line explanations, search + source/tier filter chips,
provenance per entry, Ratify/retire actions; activeView `"memory"`, Sidebar
entry with pending-review badge, store slice + SSE fold. Suite 40 files /
336 green (Node 24, isolated OMB_DATA_DIR), typecheck green. Evidence:
`platform/web/screenshot-p5-memory.png` (isolated 8903 server, seeded all
tiers/sources incl. a supersede chain + 4-item review queue; live
`/api/memory/search` returned only the accepted, non-superseded entry).
- New `server/memory.ts` + tests (port `MemoryEntry` model + trust-tier
  gates from `platform/server/agents/memory-gates.ts`; quarantine →
  agent_proposed → human_confirmed → org_ratified; storage `memory.json`).
- Routes: `/api/memory` list/propose/accept/reject/promote; wall filtering
  server-side (scope by team once P7 lands; until then org/personal only —
  leave the team filter parameterized).
- UI: `MemoryPage.tsx` with review queue tab; sidebar button.
- Verify: vitest — proposal lands quarantined, accept promotes, reject
  retires; connector-sourced entries gated (used by P6).

### P6 — Connectors registry + mock sync ✅ DONE
(commits c972fbe server, be47da7 UI, evidence commit follows)
Shipped: `server/org-connectors.ts` + `org-connectors.test.ts` (13 tests) —
`OrgConnectorManager` (manager pattern, `org-connectors.json`): 8-provider
catalog (sharepoint/onedrive/teams/outlook/confluence/jira/databricks/github),
add/configure with server-enforced access levels (memory kind strictly
read_only whatever was requested; agent kind read_only|write_no_delete,
anything else falls back to read_only — never delete), connect/disconnect
(mock; real OAuth deferred until owner supplies credentials), per-tool enable
toggles, remove (synced memory stays). Mock sync (connected memory-kind only)
ingests sampleItems via new `MemoryManager.ingestConnector` — org_ratified
source-"connector" entries, idempotent by provenance author + content
(re-sync skips, never duplicates); systems of record are trusted, review is
for agent claims. Routes under `/api/org-connectors` (named "org connectors"
— upstream's `/api/connectors` is Composio and untouched); SSE
`org_connector`/`org_connector_removed`. UI: `OrgConnectorsPage.tsx` two-pane
(add-from-catalog with kind picker, status pills, access/last-sync/item-count
stat cards, tool switches, Sync now), activeView `"connectors"`, Sidebar
Cable entry with connected-count badge, store slice + SSE folds. Suite 41
files / 349 green (Node 24, isolated OMB_DATA_DIR), typecheck green.
Evidence: `platform/web/screenshot-p6-connectors.png` (isolated 8905 server,
4 connectors, GitHub agent detail with a toggled-off tool) +
`screenshot-p6-memory-synced.png` (Memory page, Connectors source filter,
8 ratified synced entries visible end to end).
- New `server/org-connectors.ts` + tests (port catalog + mock sync
  from `platform/server/connectors.ts`; sync emits memory proposals into
  P5's queue). NOTE: upstream already owns `/api/connectors` (Composio) —
  new routes go under `/api/org-connectors` to avoid any collision; do not
  touch `server/composio.ts`.
- UI: section inside a new `AdminPage` placeholder or its own page
  (`ConnectorsPage.tsx`).
- Verify: vitest — create → sync → entries appear quarantined in memory.

### P7 — Teams, roles, admin (auth adapter) ✅ DONE
(commits 8305e8c server managers, 1f196cc index seam, e9a6e86 UI, evidence
commit follows)
Shipped: `server/org.ts` + `org.test.ts` (12 tests) — `OrgManager`
(manager pattern, `org.json`): OPT-IN org mode (off by default = today's
solo app, zero login), users (first created OR first to log in = admin),
scrypt set-on-first-use passwords (relay semantics: wrong password after
set → 401), persisted restart-safe session tokens, teams CRUD-lite with
membership on `user.teamIds`. `server/index.ts` seam: org mode OFF →
actingUser null, nothing changes (suite untouched: 42 files / 365 passed, 8 skipped, 0 failed);
ON → /api/* needs Bearer token (?token= for EventSource), open allowlist =
login/minimal org probe/health/static. Admin gates: org users/teams/mode,
all org-connector mutations, memory promote + team-scoping, goals/template/
pipeline create (autonomous spend). TEAM WALLS: `MemoryEntry.teamId` +
`MemoryViewer` filtering in memory list/search AND turn injection
(`startTurn` viewer opt threaded from the send/edit routes; no user context
= all visible) AND per-SSE-client filtering so walled entries never leak on
the shared stream (+5 wall tests). UI: `AdminPage.tsx` (org-mode switch w/
plain-language explanation, people w/ role toggle + team chips, teams w/
member chips), `LoginGate` (only when org mode on + no session),
Memory team-scope selector (admin), activeView `"admin"`, Sidebar
ShieldCheck entry, auth-aware `api()`/EventSource. Members-can't: verified
live (403 admin acts, walled entry absent from list/search). Evidence:
`platform/web/screenshot-p7-admin.png`, `screenshot-p7-login.png`,
`screenshot-p7-member-memory.png` (isolated 8907 server — Sara, Sales,
sees the org handbook but NOT the Finance-walled entry). Follow-up
documented: group sends and background turns (routines/goals/pipelines)
run with a null viewer (all memory visible to the bot) — per-user identity
threading through those engines is a later pass.
- Risk #2: upstream has NO auth. Port scrypt+session login from relay.ts as
  an OPT-IN middleware: new `server/auth.ts` + tests; disabled by default
  (`config.auth.enabled`), so the local single-user app keeps working and
  `pnpm test` stays green without fixtures logging in.
- `server/teams.ts` (+tests): `TeamRecord`, roles admin/member, membership.
- Routes: `/api/login`, `/api/teams`; when auth enabled, role-check wrapper
  around mutating routes. UI: `AdminPage.tsx` (teams, roles, connectors,
  audit tabs — tabs filled by P6/P9).
- Verify: vitest — auth disabled: everything as before; enabled: 401 gate,
  role checks; team walls now enforced in P5's memory filters.

### P8 — Costs
- New `server/costs.ts` + tests: per-turn cost records appended
  `costs.ndjson`; hook the existing `EventBus.subscribe` to record on
  turn-completed events (adapter pattern — no driver changes). Port
  estimation from dispatcher.ts `TurnCost`.
- Routes: `/api/costs` (+ per-bot rollup). UI: `CostsPage.tsx` or a
  Costs tab in AdminPage.
- Verify: vitest — fake-driver turn → one cost row; rollup sums.

### P9 — Audit + Files
- `server/audit.ts` + tests: append-only `audit.ndjson` written from the
  same bus subscription (P8's hook) + explicit `record()` calls added in
  the NEW modules only (inbox/goals/pipelines/memory/teams). Route
  `/api/audit` with filters. UI: Audit tab in AdminPage.
- `server/files.ts` + tests: port Files surface + write/read-no-delete
  policy from `platform/server/agents/sandbox.ts` (scoped to `DATA_DIR/files`);
  route `/api/files`; UI `FilesPage.tsx` or tab.
- Verify: vitest — every new-module mutation produces an audit row;
  file policy denies delete.

### P10 — Providers (anthropic/openai-compat drivers)
- Port `platform/server/agents/anthropic.ts` and `openai-compat.ts` as
  upstream drivers: new `server/drivers/anthropic.ts`,
  `server/drivers/openai-compat.ts` implementing `ProviderDriver`
  (template: `server/drivers/grok.ts`), key-gated via `config.instances`;
  register alongside existing drivers. Foundry/managed stay parked
  (decision OPEN per AGENT-MEMORY).
- Verify: vitest with mocked HTTP (upstream driver-test style,
  `server/drivers/grok.ts`'s tests as reference); shadow-instance behavior
  when no key.
- BLOCKED for live validation on owner's ANTHROPIC_API_KEY (tests don't
  need it).

### P11 — DMs/spaces polish + export/import
- Upstream already has DMs (`dm` groups) and rooms; port only the deltas:
  spaces grouping of sidebar items, presence chips (client-only), and
  `server/export.ts` porting `platform/server/yaml.ts` (`/api/export`,
  `/api/import` claudeMd onboarding → creates a bot with description).
- Verify: vitest — export round-trips through import.

### P12 — E2E walkthrough
- Port `platform/scripts/e2e-demo.mjs` to drive the UPSTREAM server API
  (question → goal → pipeline gate → connector sync → memory promote →
  costs → audit) as `scripts/e2e-platform.mjs`; add to docs, not CI.
- Verify: script exits 0 against a scratch `OMB_DATA_DIR`; `pnpm test`
  green; update `docs/AGENT-MEMORY.md` in the closing commit.

### Risks
1. **Persistence mismatch** — resolved: adapter/add (see §2); the global
   event log does NOT come across; audit/costs use append-only NDJSON tees.
2. **Auth** — opt-in only (P7); never gate existing routes by default.
3. **Route collisions** — upstream owns `/api/connectors` (Composio) and
   `/api/routines`; new features use fresh paths (`/api/org-connectors`,
   `/api/inbox`, …). Platform "routines" are NOT ported (upstream's are
   richer).
4. **`server/index.ts` growth** — keep route blocks thin; logic lives in
   the feature modules, matching the routines precedent.
5. **Node version** — upstream runs `--experimental-strip-types`; platform
   needed Node 22. Same runtime, no change.
6. **Running dev stack** — passes must not restart server 8799 / vite 5199;
   all verification is vitest + typecheck + scratch-data-dir scripts.
