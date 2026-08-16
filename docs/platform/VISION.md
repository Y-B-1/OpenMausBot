# Atrium — Platform Vision (research synthesis, 2026-08-16)

Working name: **Atrium**. A workspace where humans and a roster of AI teammates share channels, memory, and real computers — Grok Bot's messaging-app soul, Buzz's protocol discipline, Type's layered company brain, and the governance all of them lack. Web-first, multi-tenant, enterprise-sellable, self-hostable. Built on this OpenMausBot fork.

Presentation copy of this synthesis (artifact): claude.ai/code/artifact/5d4539c3-bb2e-4766-99fe-5c5b1e32d7be

## Architecture (four layers)

1. **Surfaces** — web app (prototype), later desktop/mobile + Slack/Teams/email bridges; live agent-screen viewer with human takeover. One WebSocket per client, subscription-scoped.
2. **Relay — source of truth** — append-only event log, integer-kind extensible; host-derived fail-closed tenancy; channels where humans and agents are peers; access-check-before-subscribe; approvals & moderation enforced at the identity seam; hash-chained audit.
3. **Agent core** — the OpenMausBot provider SPI (one contract, many engines); model gateway with per-agent policy (3-tier routing, spend caps, residency class); Org/Space/Personal memory with promotion gates; signed+scanned skills registry; routines (cron + event triggers); plan-then-execute data plane with execution-layer authorization.
4. **Execution** — per-task hardware-virtualized microVM behind a `SandboxProvider` interface (E2B now → self-hosted Firecracker for enterprise); durable per-agent workspace volume; egress deny-by-default proxy; credential broker outside the VM; session recording; bounded-lifetime kill switch.

## Seven load-bearing principles

1. **The event log is the product** — transcripts, notifications, memory candidates, audit are all projections of one append-only stream (Buzz + OpenMausBot's fold).
2. **Agents are a security boundary** — per-agent identity, credentials, memory, computer. Grok Bot's "do not use separate Bots as a security boundary" is our roadmap.
3. **Persistence without shared blast radius** — durable workspace per agent + disposable microVM per task (Grok continuity UX × Cloudflare's durable-FS split).
4. **Numbers come from executed plans** — quantitative answers are inspectable, re-runnable plans run under the asking user's permissions (PromptQL).
5. **Memory is governed, tiered, and data — never directives** — Personal→Space→Org promotion with human gates, provenance + trust tiers, quarantine for external content, version chains with rollback, GDPR true-delete escape hatch.
6. **Skills compound under governance** — distilled skills are proposals: quarantined, scanned, signed, approved (Hermes's loop minus its CVEs; ClawHavoc as the cautionary tale).
7. **Model choice is policy, not plumbing** — per-agent model policy; orchestrator/worker/classifier tiers behind LiteLLM + native SDKs; BYO keys → Bedrock/Vertex EU → self-hosted weights as config-level re-points.

## The two hard questions

**VMs & data security**: microVM per task, snapshot starts (~150 ms), egress deny-by-default, credentials brokered outside the VM (short-lived scoped tokens attached by a gateway the model never sees). Prompt injection contained by construction. Prototype on E2B (~$0.17/hr per 2vCPU); `SandboxProvider` keeps the Firecracker-on-bare-metal swap clean — and sellable. Full audit chain: commands, file writes, egress, credential use, approvals.

**Models & self-hosting**: three-tier routing is the biggest cost lever (70–85% of calls on cheap tiers). Regulated tenants: private cloud, not GPUs — Claude via Bedrock EU inference profiles or Vertex EU regions (red-team corrected: hyperscaler-only, not Bedrock-only). True self-hosting (vLLM/SGLang, Qwen/GLM/DeepSeek) pays only above ~3–5B steady tokens/mo + 1–2 MLOps FTEs.

## Source attribution — what we took / rejected

| Source | Take | Reject |
|---|---|---|
| **Grok Bot** | Product shape: named bots with personas, skills→routines, learn-by-demonstration, live screen + takeover, group chats with handoff, proactivity. Its features = our table stakes. | Shared per-account VM, human-credential hijacking, opaque metering, zero compliance. Its weaknesses = our enterprise wedge. |
| **Buzz** | Fail-closed host tenancy; 12-step event pipeline; channel-scoped fan-out boundary; access-check-before-subscribe; kind-integer extensibility; moderation at the auth seam; presence-as-lease; hash-chain audit; remote-agent axiom (no control channel after deploy; self-reap + substrate kill switch). | Nostr wire format, per-event Schnorr signing, raw-keypair identity (no SSO/SCIM), the Rust runtime. Design source, not dependency. |
| **Type** | Spaces as the unit of sharing (knowledge+connectors+skills+memory); Org/Space/Personal memory shape; import-from-Claude-Code onboarding; BYO economics (via API keys — consumer-plan ToS risk). | Its unpublished memory mechanics — ours come from Letta (shared core blocks), Zep (bi-temporal invalidation), Mem0 (scoping + reversibility lesson), Supermemory (version chains, RBAC), Honcho (synthesized profiles), Claude Code (promotion-as-review). |
| **PromptQL** | Plan-then-execute contract; execution-layer authz keyed to end user; versioned semantic metadata; plans as chat artifacts. | Heavyweight supergraph prerequisite; own-silo distribution. |
| **OpenClaw** | Gateway pattern (hub, channel adapters, agents); cron/heartbeat proactivity; cross-channel continuity; its security record as a negative spec (135k exposed, ClawHavoc 341 malicious skills, Microsoft's verdict). | Every default: open control plane, ambient credentials, unsigned registry, permissive egress — all inverted. |
| **Hermes Agent** | Skill distillation as governed proposals; pluggable execution backends; subagent spawning; A2A + signed webhooks; grounded citations. | Memory/skills as instruction authority (poisoning vector); approval-skips; regex guards. 4 Critical + 9 CVEs = anti-pattern catalog. |
| **Cloudflare Computer** | Durable-workspace/disposable-compute split; isolates for most work, kernels on demand; credential injection; jurisdiction pinning. Candidate SandboxProvider backend. | Betting the core on it: 10 GB cap, DO write serialization, preview APIs, Aug 2026 incidents. |
| **OpenMausBot (upstream)** | Provider SPI (`server/contracts.ts`), event-fold-as-projection, branching message DAG, group routing + hop caps, approval-card lifecycle, Composio connectors, fake-CLI test harness, split-context streaming UI. | Electron shell, JSON-file storage, SSE broadcast-to-all, unauthenticated localhost REST (CSRF-drivable), logged-in-CLI drivers, single-VM lease. |

## Next

charge:design spec (alignment interview with owner) → charge:plan (red-teamed tickets) → web prototype: multi-tenant relay with channels, 2–3 live agents, tiered memory with review queue, one sandboxed computer with live screen, approval flow — the thin end-to-end slice.
