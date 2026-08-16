# Buzz (block/buzz) — Deep-Dive Code Study

**Repo:** `/workspace/block/buzz` (shallow clone, HEAD `d8281b9`, 2026-08-15, PR #5116).
**License:** Apache 2.0, Block, Inc. **Tagline:** "A workspace where humans and agents build together, on a relay you own."

---

## 1. Architecture

### 1.1 The core bet
Buzz is a self-hosted Slack-shaped workspace where **every action is a signed Nostr event in one append-only log** — chat message, reaction, workflow step, canvas edit, git patch, huddle join. `ARCHITECTURE.md` §1: adding a feature means **defining a new `kind` integer**; existing clients ignore unknown kinds and nothing breaks. The relay is the *single source of truth* — no P2P/gossip in the core path (`buzz-relay-mesh` is a separate experiment).

The tenant unit is a **community**, resolved from the request **host** before any handler runs ("Step 0: Community Binding"). Unknown hosts **fail closed**; NIP-98 stamps must *agree with* the host-derived community rather than override it. The single most transferable design decision in the repo for a multi-tenant platform.

### 1.2 Crate layout (30 crates)
**Zero-I/O core** — `buzz-core`: types, `verify_event()` (Schnorr + SHA-256), `filters_match()`, `is_private_ip()` SSRF guard, and the kind registry (`crates/buzz-core/src/kind.rs`, **129 `pub const KIND_*`**). Its Cargo.toml *forbids* tokio/sqlx/redis/axum.

**Services (siblings, never call each other)**
- `buzz-db` — Postgres. `insert_event` with `ON CONFLICT DO NOTHING`; transactional TOCTOU-safe role enforcement; soft-delete via `removed_at`; normalized `event_mentions` join; monthly range partitions with a **DDL-injection allowlist**.
- `buzz-auth` — NIP-42 (WS challenge/response, ±60s) and NIP-98 (signed HTTP auth). 14-variant `Scope` enum; `ChannelAccessChecker` / `RateLimiter` traits.
- `buzz-pubsub` — Redis. Dedicated PSUBSCRIBE connection, `broadcast::channel(4096)`, backoff 1s→30s. Presence = `SET buzz:presence:{pk} EX 180` (3× the 60s heartbeat). Typing = ZADD/ZREMRANGEBYSCORE, 5s window, 60s TTL.
- `buzz-search` — Postgres FTS: `events.search_tsv` **generated tsvector column** + GIN; privacy kinds NULLed *at storage level* so they can never match; returns **candidates**, relay re-authorizes every hit.
- `buzz-audit` — SHA-256 hash chain, genesis 64 zeros, `pg_advisory_lock` single-writer, canonical BTreeMap JSON.
- `buzz-workflow` — YAML automation; 4 triggers, 7 actions, `evalexpr` conditions with 100ms timeout, `Semaphore(100)` `try_acquire` (fail fast).

**The server** — `buzz-relay` (Axum), the only crate importing all subsystems; hosts huddle audio inline (WebSocket Opus relay, NIP-42 per-participant, soft cap 25 peers, no external SFU).

**Agent surface** — `buzz-cli` (JSON in/out, 21 command modules), `buzz-acp` (harness bridging relay @mentions → Goose/Codex/Claude Code over ACP JSON-RPC), `buzz-agent`, `buzz-dev-mcp`, `buzz-persona`.

**Other** — `buzz-push-gateway`, `buzz-media` (Blossom/S3), `buzz-voice`, `buzz-deletion`, `buzz-relay-mesh`, `buzz-conformance`, `buzz-backend-kubernetes`, `git-sign-nostr`, `git-credential-nostr`, `sprig`.

### 1.3 Protocol: identity, auth, channels, messages
**Identity is a secp256k1 keypair.** Humans and agents are indistinguishable at the protocol layer. Authorization is by identity + channel membership, not permission flags.

**Auth**: connection → semaphore → relay sends `["AUTH", challenge]` → client returns signed `kind:22242` → `AuthState: Pending → Authenticated`. AUTH events never stored/audited. Optional pubkey allowlist and `relay_members` gate, fail-closed.

**Channels are NIP-29 groups** (UUID in `#h` tag). Kind 9 messages, 9000/9001 add/remove, 9007 create, 9021/9022 join/leave, relay-signed 39000/39001/39002 discovery. Channel types: Stream, Forum, Dm, Workflow. Roles: Owner, Admin, Member, Guest, Bot.

**Message model:** kind 9 stream message, 40002 rich v2, 40003 edit, 7 reactions (channel derived from the `#e` target, not the client's `#h`), 5 self-authored deletions, NIP-10 threads with atomic `thread_metadata`, NIP-17 gift-wrapped DMs (kind 1059, never indexed).

**Event pipeline** (`handlers/event.rs`, ARCHITECTURE §4) — 12 steps worth copying verbatim: auth → pubkey match → reject AUTH kind → ephemeral route → verify (spawn_blocking) → membership → DB insert → Redis publish → fan-out → search index (bounded queue, cap 1000) → audit (spawned) → workflow trigger (spawned). Steps 10–12 fire-and-forget; failure never fails the write. `OK` sent at the end.

**Fan-out** is a three-tier DashMap: `(channel_id, kind)` O(1) → `channel_id` wildcard → global linear scan. Security boundary: **channel-scoped events are never delivered to global subscriptions**. REQ handler checks channel access **before** registering (closes the race). Global REQs on p-gated kinds must carry `#p` = authenticated pubkey.

**Slow clients:** `try_send` with a 3-strike grace counter.

### 1.4 Storage & migrations
`schema/schema.sql` — 60 tables. `migrations/` — 31 sequential files; the list is a roadmap (0006 moderation, 0012–0018 push, 0016 community archival, 0029/0030 community deletion/recovery, 0026 replica heartbeat). `events` and `delivery_log` range-partitioned monthly.

### 1.5 Push gateway
`buzz-push-gateway` — "stateful, capability-gated APNs last hop for NIP-PL": App Attest, grants, tokens, replay-guard tables, formal spec at `docs/formal/nip-pl/`; own Helm chart.

### 1.6 Agents as peers
An agent is a keypair with channel memberships. `buzz-acp` connects over WS with NIP-42, discovers channels via REST, and queues @mention events **per channel with at most one prompt in flight**, batching queued events into one `session/prompt`. Pool of 1–32 subprocesses with claim/return and crash-respawn. Agent kinds: 10100 profile, 30174 engram (durable memory), 30175 persona, 30176 team, 30177 managed agent, 30178 team catalog, 30179 private managed agent, 24200 observer frame.

### 1.7 Moderation (`VISION_MODERATION.md`)
**Reports are signals, never triggers** — no auto-removal. Reports are private structural state, never in the event log, never fanned out (reporter identity can't leak). Moderation commands are signed events (9040–9044) validated against roster role — an admin cannot ban an owner. **Enforcement lives at the identity seam**: bans bite at authenticate-time. Honest tombstones; restricted users get a DM stating what/why/how long. No shadow bans, no automod.

### 1.8 Remote agents (`VISION_REMOTE_AGENTS.md`)
The axiom: **"after deploy, the desktop retains no substrate control channel."** Launch is a one-way handoff; everything afterward flows through the relay — read the agent's messages for status, @mention to steer, tell it to stop and it exits. Presence means *available for conversation*, never substrate telemetry. Agents **self-reap** on inactivity. Deployment goes through a swappable **provider** binary whose contract never mentions containers (preserve identity, fail closed with the key, converge to one live instance, bound lifetime, keep secrets out of config), pinned by `buzz-conformance`; `buzz-backend-kubernetes` is the first substrate. "Honest Costs" admits the k8s Secret blast radius and the lack of a guaranteed kill switch.

---

## 2. Surfaces & tech stack

| Surface | Path | Stack |
|---|---|---|
| Desktop (primary, v0.5.14) | `desktop/`, `desktop/src-tauri/` | Tauri 2 + React 19 + Vite 8 + TS, TanStack Router/Query/Virtual, Radix, Tailwind 4, TipTap 3. Rust side: egress_guard, identity_storage, key_backup, media_proxy, managed_agents, mesh_llm, huddle. |
| Web | `web/` | React 19, Vite 8, TanStack, nostr-tools, isomorphic-git + lightning-fs (in-browser git), Tailwind 4. |
| Admin-web | `admin-web/` | Deliberately tiny: 7 files. Vitest + Playwright. |
| Mobile | `mobile/` | Flutter (Dart ^3.11.4), hooks_riverpod 3, nostr ^2.0.0, flutter_secure_storage. |
| Tooling | root | pnpm 11.4 workspace, Biome 2.4, `just`, Hermit, lefthook, renovate. Custom lints: check-file-sizes, check-px-text, check-pubkey-truncation. |

---

## 3. Reusable for a TypeScript/Node multi-tenant "humans + agents in channels" platform

**Liftable as design, near-verbatim:**
1. **Host-derived tenancy resolved before any handler** (+ TLA+ model `docs/spec/MultiTenantRelay.tla` and Tamarin proof `MultiTenantAuth.spthy`). "The URL is authoritative, client tags never override, unknown host fails closed" — the hardest part of multi-tenancy to retrofit.
2. **The 12-step event pipeline ordering** with fire-and-forget tails behind a bounded queue.
3. **Three-tier fan-out index + "channel-scoped events never reach global subscriptions."**
4. **Access-check-before-subscribe** (eliminates the registration race).
5. **Kind-integer extensibility**: one event table, one integer discriminator, unknown kinds ignored → additive schema evolution. `kind.rs` is a ready-made 129-entry taxonomy to crib.
6. **Search as a generated tsvector column with privacy kinds nulled at storage**; search returns candidates, the app re-authorizes.
7. **The moderation loop**: private reports; enforcement at the auth seam; honest tombstones; closed-loop notices.
8. **The remote-agent axiom** (no control channel after deploy; steer via the message bus; self-reap on inactivity) — arguably the single best idea here for an agent platform, runtime-independent.
9. **Per-channel single-in-flight prompt queueing with batching** (`buzz-acp/src/queue.rs`) — the right concurrency model for agents-in-rooms.
10. **Presence-as-lease** (TTL = 3× heartbeat) and typing-as-sorted-set-window — copy the Redis key shapes.
11. **Hash-chain audit** with advisory-lock single-writer and canonical key ordering.
12. **Ops assets**: Helm charts with values.schema.json, compose files.
13. **Agent-first CLI shape**: JSON-in/JSON-out designed for LLM tool calls.

**Rust/Nostr-specific, don't port:** per-event Schnorr signing (unneeded with server-side sessions), NIP-29/42/17/34/Blossom wire compatibility (only if third-party Nostr interop is a goal), the custom NIP suite (read as design docs), Tauri/Flutter clients, huddle Opus relay, DashMap/semaphore idioms.

---

## 4. Strengths, weaknesses, maturity

**Strengths.** Genuinely rigorous: TLA+ + Tamarin formalism; "Known Limitations" as a verified-gaps table; per-crate explicit "Does NOT:" clauses; systematic security (SSRF allowlists, DDL-injection guards, constant-time secret compare, TOCTOU-safe membership, hashed single-use approval tokens, fail-closed everywhere).

**Maturity.** 21 CI workflows (~21 jobs in ci.yml: change-detection gating, sharded desktop E2E, relay-e2e, security, cross-compile). 263 Rust files with tests; 134 relay E2E tests. 290KB CHANGELOG; PR numbers near #5914 → very high velocity. Full governance docs.

**Weaknesses.** Pre-1.0 (v0.5.14). ~~No rate limiting enforced~~ (RED-TEAM corrected: a Redis-backed atomic Lua INCR+EXPIRE limiter IS live in the admission path at HEAD — `buzz-pubsub/src/rate_limiter.rs`, wired via `state.rs:855`, `connection.rs:666/689`; caveat: fixed-window allows 2× burst at boundaries). Also corrected: buzz-acp's default in-flight policy is **Drop**, not queue-and-batch — queueing (max 50 events/batch) is opt-in. Approval gates fail rather than suspend. Some workflow actions NotImplemented. No sqlx offline cache (queries not compile-time validated). Multi-community mode partly prospective. NIP-29 gaps (9009 invite no-op). Pubkey allowlist has no CLI. Unsigned Windows builds. Mobile still being wired. Very large surface (30 crates, 129 kinds, 60 tables, 4 clients) for a small team.

**Bottom line: treat Buzz as a design source, not a dependency.** Read ARCHITECTURE §3–§5/§7, VISION_MODERATION, VISION_REMOTE_AGENTS, docs/multi-tenant-relay.md, kind.rs. Port the tenancy binding, pipeline ordering, fan-out security boundary, moderation loop, and no-control-channel agent axiom. Leave the Nostr wire format and Rust machinery behind.
