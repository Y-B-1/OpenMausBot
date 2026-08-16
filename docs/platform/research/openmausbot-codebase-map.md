# OpenMausBot — Architecture Map & Platform Reuse Assessment

## 0. One-paragraph summary

OpenMausBot is a **local-first desktop chat app** (v0.1.17, MIT, Node ≥24, pnpm 10). The user creates "bots" (personas), each bound to a **provider instance** wrapping a locally-installed agent CLI (Claude Code, Codex, Grok, Kimi, Gemini/Antigravity via ACP) or a remote API/VM runner. Three processes: the **Vite/React 19 renderer**, an **Electron main shell**, and a **harness server** (plain `node:http`, no Express) that owns every agent subprocess. Clients hold no transports — the renderer only does HTTP `fetch` + one **SSE** stream (`GET /api/events`, `server/index.ts:1075`, fan-out at `:142-153`). There is no WebSocket anywhere.

---

## 1. Overall architecture

```
Electron main (electron/main.mjs)
 ├─ forks harness server as utilityProcess (dist-server/index.js, port 8799+)
 ├─ serves built UI, CUA driver lifecycle, speech helper, auto-updater
 └─ BrowserWindow → preload.cjs → window.ogb bridge

Harness server (server/index.ts, 1647 lines — the god module)
 ├─ ProviderRegistry (server/harness/registry.ts) — instanceId → live driver
 ├─ EventBus (server/harness/bus.ts) — fan-in, NDJSON tee, subscribe()
 ├─ Store (server/store.ts) — bots, groups, tasks, messages (JSON files)
 ├─ startTurn() (:432) — turn dispatch
 ├─ bus.subscribe fold (:174-340) — events → persisted messages → SSE
 ├─ group turn engine (:708-855) — multi-agent rooms
 ├─ RoutineManager (server/routines.ts) — schedules
 └─ raw node:http router (:937-1640)

React renderer (src/) — StoreProvider reducer + EventSource + fetch
```

### Architectural doctrine worth preserving verbatim
- **Canonical event stream is the source of truth**; the persisted transcript and every client view are *projections* of it (`server/index.ts:155-157`). Exactly right for a multi-tenant platform.
- **Server-side folding**: the server turns provider events into `Message` records; any new client (web, mobile, Slack) inherits a correct transcript for free.
- **Shadow instances**: an unknown/undecodable driver config becomes an `unavailable` snapshot, never a startup failure (`server/harness/registry.ts:36-48`).

---

## 2. Server modules

### 2.1 Contracts — `server/contracts.ts` (222 lines) ⭐ the crown jewel
- `RuntimeEvent` — ~14-member discriminated union (`session.started/exited`, `turn.started/completed`, `item.started/updated/completed`, `content.delta`, `request.opened/resolved`, `thread.token-usage.updated`, `runtime.error`) over a common base carrying `eventId, provider, providerInstanceId, threadId, turnId, itemId, requestId, createdAt, raw`.
- `ProviderAdapter` — `sendTurn / interruptTurn / respondToRequest / hasSession / stopAll / onEvent`.
- `ProviderDriver<Config>` — `driverKind, metadata, install, decodeConfig, defaultConfig, models, create`.
- `SendTurnInput.integrations` — `composio | computer | localComputer | agents`, plus `system`, `transcript`, `resumeCursor`, `cwd`.
- `EngineInstall` — per-platform install command, docs URL, sign-in command; UI renders from this.

### 2.2 Drivers — `server/drivers/`
| File | Kind | Mechanism |
|---|---|---|
| `claude.ts` (532) | `claudeAgent` | per-turn `claude` CLI, `stream-json` both ways, `--resume`; permission broker = `net` server on per-turn unix socket + `permission-proxy.ts` MCP server inside the CLI |
| `codex.ts` (447) | `codex` | Codex app-server protocol |
| `acp/core.ts` (550) | shared | Generic **Agent Client Protocol** runtime: JSON-RPC 2.0 over stdio; `session/request_permission` → `request.opened`; replay-gating via `_meta.isReplay` |
| `acp/grok.ts`, `acp/gemini.ts`, `acp/kimi.ts` | ACP harnesses | tiny support objects: spawn argv, auth method, model catalog |
| `antigravity.ts` (376) | `antigravityAgent` | Google `agy` CLI |
| `grok.ts` (229) | `grok` | API-key (xAI) transcript-replay driver — the only non-CLI text driver |
| `boxagent.ts` (275) | `boxAgent` | turn runs on the remote box VM via `POST /boxes/{id}/prompt` + event polling |
| `agents-proxy.ts` (141) | — | stdio MCP proxy giving an agent `list_bots` / `ask_bot` |

Registration: one static array in `server/drivers/builtIn.ts`. **Adding an engine = one file + one array entry.**

### 2.3 Store — `server/store.ts` (720 lines)
- `BotRecord`: `threadId`, `tasks[]`, persona, `modelSelection {instanceId, model}`, `resumeCursors`, `computer: cloud|vm|local|off`, `autoApprove`, `alwaysAllow[]`, `chiefOfStaff`, `busy`, …
- `TaskRecord`: per-task thread + per-task resume cursors.
- `Message`: `kind: text|options|activity|screen`, `parentId` (branching DAG — edits fork; `activePath()`/`branchMessage()`), `from` (group sender attribution), `reactions[]`, `comm`, `card` (`OptionCardData` with `requestId/tool/allowKey/held`).
- `GroupRecord`: `memberIds`, `defaultResponder: member|everyone|mentions`, `bulletin` (shared system-prompt fragment), `dm` flag.
- `mentionedBots()` (`:196`) — longest-name-wins @mention resolver; `roomResponders()` (`:244`).
- Persistence: `writeFileAtomic` to `bots.json`, `groups.json`, `messages-<threadId>.json`.

### 2.4 Turn dispatch — `startTurn()` `server/index.ts:432-678`
Busy-flag flips synchronously, dispatch runs detached (box provisioning ~90 s). Builds transcript from active branch only (last 40 text messages), handles `rewound` history for cursor-resuming drivers, composes persona system prompt, resolves computer destination strictly, attaches Composio + agents integrations.

### 2.5 Event fold — `server/index.ts:174-340`
Single `bus.subscribe` closure: broadcasts to SSE; feeds RoutineManager; maps `threadId` → bot or group; folds `session.started` → cursor, tool items → activity chips (keyed `threadId:itemId`), `assistant_text` → message, `request.opened` → auto-approve check (`server/auto-approve.ts`) or options card (chip written only after the provider accepts the answer), `turn.completed` → clear busy, release VM lease, capture final screen frame. SSE kinds: `runtime, message, message.patch, bot, group, screen, config, routine*`.

### 2.6 Multi-agent coordination
- **Rooms** (`index.ts:708-855`): responders run sequentially through per-group promise chains; each member gets a serialized 30-message room context + roster + bulletin as a fresh-session turn; @mention chaining capped at `MAX_GROUP_HOPS = 1`; `spoken` set prevents double-runs.
- **Peer comms** (`/api/internal/agents`, `/api/internal/ask-bot`): `askBotAndWait` folds assistant text, resolves on `turn.completed` or 4-min ceiling. Guarded by per-boot `COMMS_TOKEN`, `MAX_COMMS_DEPTH = 1`. Exchanges mirrored into auto-created `dm` group channels.
- **Chief of Staff** (`server/chief-of-staff.ts`): one workspace-wide coordinator; system prompt names the live roster each turn; singleton enforced on load.

### 2.7 Computer / VM integration
- `server/box.ts` (331) — remote Box (`ascii.dev/api/box/v1`) cloud desktop: deterministic per-bot box name, provision/join/sleep/exec/screenshot; stream tokens rotate per state change, never persisted.
- `server/computer-proxy.ts` (770) — stdio MCP server exposing CUA-grade tools over the box REST endpoint; act+settle+capture+base64 in one shell command, JPEG frames inline in tool results, `computer_batch`.
- `server/container-computer.ts` (644) — local VM: podman/docker from a digest-pinned `trycua/xfce-cua` base, single-bot lease via `activeVmThreadId`.
- Live screen: `startScreenPoller` (`index.ts:353-431`) → SSE `{kind:"screen"}` → final frame folded into transcript.

### 2.8 Composio connectors — `server/composio.ts` (171)
Connect meta-MCP (`connect.composio.dev/mcp`, `ck_…` key) for connection state + OAuth links; v3 toolkits catalog (`backend.composio.dev/api/v3`, `ak_…` key) for the marketplace. Routes: `/api/connectors*`. The agent receives a streamable-HTTP MCP URL in `integrations.composio`.

### 2.9 Routines — `server/routines.ts` (493)
`Routine {name, prompt, botId, runOn: maus|cloud, schedule: once|daily, durationMinutes, nextRunAt}` + `RoutineRun` history. Runs land in detached tasks (own thread), never contaminating interactive conversation.

### 2.10 HTTP surface (`server/index.ts:937-1640`)
Raw `createServer`, hand-rolled regex routing. Full REST surface for bots/messages/branches/cards/tasks/computer/groups/routines/connectors/tts + `/api/events` SSE. **No authentication, no user identity, no tenancy, no CORS/CSRF anywhere.** Only `COMMS_TOKEN` on `/api/internal/*`.

---

## 3. Frontend (`src/`)
- `App.tsx` — `DesktopCapabilitiesProvider > StoreProvider > Shell`; views `RoutinesPage | NoEngines | GroupView | ChatView` + overlay panels.
- `src/state/store.tsx` (1246) — one `useReducer` + command-dispatch wrapper: optimistic local update + matching REST call; a single `EventSource("/api/events")` folds server events back in. **Split contexts for perf**: `StreamContext` holds in-flight streaming text per threadId outside the reducer, batched per animation frame — sidebar and settled transcript never re-render during a stream. Client mirrors of server types are hand-duplicated.
- Components (33): `ChatView` (808), `Sidebar` (664), `Composer` (405), `GroupView` (378), `ModelPicker` (164 — renders from `/api/instances` + `EngineInstall`), `ApprovalCard`/`OptionCard`, `ComputerPanel` (582), `PluginsPanel` (237), `RoutinesPage` (651), `CallView`/`GroupCallView` (voice), `ChatMarkdown` (react-markdown + shiki). `CursorAvatar.tsx` (1662 — mascot engine, largest file).
- Styling: Tailwind v4 + `src/styles.css` design tokens.

## 4. Electron shell (`electron/`)
`main.mjs` (353) — forks compiled server via `utilityProcess` with port fallback and PID-matching health probe. `preload.cjs` — narrow `window.ogb` bridge (capabilities, screenFrame, speech, TCC permissions, updater). CUA driver lifecycle, Swift speech helper, electron-updater against `milind-soni/openmausbot-releases`.

## 5. Build / dev / test
- Dev: `pnpm dev` (Vite :5199, proxies `/api` → :8799) + `pnpm dev:server` (`node --experimental-strip-types` — strip-only TS: no enums, `.ts` import extensions) + `pnpm dev:desktop`.
- Tests: Vitest, node env, `fileParallelism: false`. `server/testing/` ships **fake CLIs** (`fake-claude-cli.ts`, `fake-codex-app-server.ts`, `fake-acp-cli.ts`, `fake-driver.ts`) — the test seam that makes driver work tractable. ~30 test files; notable: `branching.test.ts`, `comms.test.ts`, `index.test.ts`.

## 6. Data storage — `~/.openmausbot/`
`config.json` (keys, profile, instances), `bots.json`, `groups.json`, `messages-<threadId>.json`, `routines.json`, `events/<threadId>.ndjson` (canonical RuntimeEvent log), `native/…` (raw protocol dumps). Overridable via `OMB_DATA_DIR`. Secrets never echoed back — `/api/config` returns configured-or-not booleans only.

---

## 7. Reusable for a web-first multi-tenant Slack-like platform

**Tier A — port nearly as-is (the actual value of this repo):**
1. `server/contracts.ts` — RuntimeEvent union + ProviderAdapter/ProviderDriver SPI.
2. `server/harness/registry.ts` + `bus.ts` — registry with shadow-downgrade; fan-in bus with NDJSON tee (needs a tenant dimension).
3. **Event-fold-as-projection model** (`index.ts:174-340`) — the single most transferable decision.
4. `server/store.ts` **domain model** (not its storage): branching `Message`, `GroupRecord` with responder policy + bulletin, `TaskRecord` with per-thread cursors. Already close to a Slack channel model where members happen to be agents.
5. `mentionedBots()` / `roomResponders()` + the group turn engine — humans-and-agents routing logic, unit-tested.
6. `server/auto-approve.ts` + approval-card lifecycle — maps directly onto per-workspace/per-role approval policy.
7. `chief-of-staff.ts` + `agents-proxy.ts` + `askBotAndWait` — delegation primitives; depth caps and scoped tokens are the right instincts.
8. `server/composio.ts` — already remote-API-based; move the key to a per-workspace credential record.
9. `src/state/store.tsx` split-context streaming pattern + optimistic-dispatch wrapper.
10. `server/testing/fake-*.ts` — keep the fake-CLI harness.
11. `ModelPicker` + `EngineInstall` — capability-driven UI from server snapshots.
12. `server/atomic.ts`, `server/box.ts` (already cloud-shaped), `server/routines.ts` scheduling model.

**Tier B — reusable design, re-implement:** `startTurn()` (must become tenant-scoped, queued, horizontally schedulable); `computer-proxy.ts` act-and-observe latency technique.

## 8. Desktop/local-only — must be replaced

| Area | Why it breaks on a web platform |
|---|---|
| **Auth/tenancy: total absence** | No user, workspace, session, or authz; `botId`/`threadId`/`groupId` are global unscoped identifiers. The largest single gap. |
| **Transport** | SSE broadcast to *all* clients; regex router; no CORS/CSRF/rate limiting. Needs WS with per-connection subscription scoping + a real router. |
| **Storage** | Whole-file JSON rewrites per message, in-process memory, single-node. Domain types survive; persistence does not. |
| **Secrets** | One global `config.json`; keys injected into every instance env. Needs per-workspace encrypted credentials, per-agent scoping. |
| **Local CLI agents** | Spawn user-installed, already-logged-in binaries; no per-tenant credential model. Become sandboxed containers with injected credentials, or API-backed drivers (`drivers/grok.ts` is the existing example of that shape). |
| **Unix-socket permission broker** | Assumes CLI and harness share a machine. |
| **Local computer control** | podman/docker on user host, single shared VM one-thread lease, host CUA. Multi-tenant needs per-session ephemeral sandboxes. |
| **Electron shell entire** | All of `electron/**`; `DesktopCapabilitiesProvider` becomes a no-op shim. |
| **Global-singleton in-memory maps** | `toolMessageByItem`, `groupQueues`, `screenPollers`, `activeVmThreadId`, module-level `cfg` — single-node only. |
| **Chief of Staff singleton** | Must become per-workspace. |
| **Config hot-reload** | `reloadProviders()` tears down the entire fleet and kills in-flight turns on any change — unacceptable with shared tenants. |

## 9. Extension points
- **New engine**: one `ProviderDriver` file + one line in `builtIn.ts`; UI renders from `EngineInstall` + `ModelCatalog`.
- **New agent tool**: add a key to `SendTurnInput.integrations` + a stdio JSON-RPC MCP proxy in the house style (raw JSON-RPC, no SDK, env-injected config).
- **New event type**: extend `RuntimeEvent`, add a fold case; SSE/NDJSON/routines are generic.
- **Driver capabilities**: `adapter.capabilities.{sessionModelSwitch, agentsMcp, computerMcp}` gate what a bot is told it has.
- **Room routing policy**: `GroupDefaultResponder` tagged union, normalized in one place — natural seam for channel-level agent-participation rules.
- **Computer backends**: `integrations.computer` vs `integrations.localComputer` is a two-shape abstraction; a cloud-sandbox backend slots in beside `container-computer.ts`.

## 10. Risks / gotchas for a port
- `server/index.ts` is a 1647-line god module mixing routing, folding, orchestration, screen polling, VM leasing and config — split it first; `index.test.ts`/`branching.test.ts`/`comms.test.ts` give partial cover.
- Server and client duplicate type definitions by hand — a shared contracts package is the obvious first refactor.
- `--experimental-strip-types` constrains server TS to strip-only syntax; removing Electron removes the reason for it.
