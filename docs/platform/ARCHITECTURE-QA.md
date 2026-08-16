# Architecture Q&A — self-interrogation, 2026-08-17

Owner-voice document: the questions I would ask myself before betting further
on Atrium, each answered to a decision. Binding outcomes are mirrored in
`docs/AGENT-MEMORY.md`.

## 1. Was Wave 6 built on buzz, on OpenMausBot, or neither?

Neither, in code. `platform/` is a greenfield TypeScript workspace that
imports nothing from upstream OpenMausBot's `src/`/`server/` and nothing from
buzz. Both were pattern sources: buzz gave the event-log/relay/scoped-fan-out
architecture and the QUEUE-vs-Drop dispatch decision (see
`research/buzz-code-study.md`); OpenMausBot gave the repo, the design tokens
for dark mode, and the motion set. The video gave the feature taxonomy.

## 2. If I had to pick a base, which is best?

Keep the greenfield. OpenMausBot upstream is a single-user Electron chat app
with no auth or tenancy — wrong spine for a multi-tenant web platform, but its
Electron shell is a good future desktop client pointed at the Atrium relay.
Buzz is the closest architectural cousin, but adopting it wholesale means
inheriting Block's roadmap and losing our fail-closed tenancy seam, memory
gates, and guardrail engines — the parts that are the product. Mine both;
own the spine.

## 3. What is running now, and what is pending?

Nothing is running; Wave 6 is committed and pushed, dev servers stopped.
Pending, in order: (1) Foundry driver (below), (2) work-agent runner via the
Claude Agent SDK (below), (3) webhook triggers (routines exist; inbound
webhooks don't), (4) YAML import + CLI pull (export shipped), (5) PWA + push
notifications for the inbox, (6) parallel step type in pipelines (fan-out +
join), (7) real sandbox provider (E2B/Azure) replacing LocalSandbox, (8)
multi-org resolveOrg + SSO wrap + RBAC, (9) librarian as a first-class
pipeline step writing through memory gates.

## 4. Azure Foundry keys — what does that decision actually buy and cost?

**Decision (binding): model access via Microsoft Foundry.** Claude is served
on Foundry with first-party pricing billed through the Microsoft Marketplace,
keys and quota live in our Azure tenant, Entra auth and private endpoints
apply — that is the enterprise-compliance story.

How it lands in code: the driver seam already isolates this. Add a `foundry`
driver next to `anthropic`/`mock` using the official Foundry client
(`@anthropic-ai/foundry-sdk` in TypeScript — `new AnthropicFoundry({...})`
against `https://<resource>.services.ai.azure.com/anthropic/v1`), same
Messages API surface, secrets from Key Vault, never in the repo. Agent
records pick `driver: "foundry"` per agent.

The cost, and it is the load-bearing constraint: **Managed Agents does not
run on Foundry.** Anthropic's hosted agent platform (what the video calls
cloud-managed agents — sessions, containers, environments, session budgets,
outcomes) is Claude-API-only. Several Messages features are also beta-or-
absent on Foundry (no fast mode, no server-side fallbacks). Consequence:
under the Foundry constraint we cannot rent the harness+deployment layer —
which retroactively validates Wave 6: our own orchestration (goals,
guardrails, pipelines, inbox) IS the replacement for the layer Foundry
doesn't carry. Implementation ticket must verify region/model availability
and quota for our subscription before wiring the driver (charge:research,
Microsoft Learn as source).

## 5. VMs — use cases, when an agent gets one, and precisely how

Three execution tiers, one seam (`SandboxProvider`):

- **Tier 0 — LocalSandbox (exists).** Allowlisted argv on the relay host.
  Demo-grade only.
- **Tier 1 — ephemeral sandbox per session.** Firecracker-style micro-VM or
  container that lives for one task: pull repo → work → commit → destroy
  (the video's container model). Azure-native fit: Container Apps dynamic
  sessions or jobs; E2B if we accept a non-Azure dependency. For untrusted
  code execution and clean-room task isolation.
- **Tier 2 — persistent runner VMs.** A pool of long-lived VMs running our
  runner daemon. Use cases: (a) repo work needing warm clones, build caches,
  browsers, heavy toolchains; (b) cost arbitrage — workers on subscription
  CLIs/cheap models while planners stay on Foundry API (the video's $10
  Hetzner move, done compliantly); (c) private-network reach — agents that
  must touch VNet-internal systems; (d) data residency — code never leaves
  our tenant.

**When does an agent get one?** Only when the task needs execution: repo
checkout, >10-minute wall clock, OS/toolchain, or VNet access. Chat-only
agents never get a VM — they get the thin harness and scoped tools. The goal
record gains an `execution: cloud | runner` field (video's planner/worker
split).

**Precisely how:** outbound-only work queue — the proven pattern (it is
exactly how Anthropic's own self-hosted sandboxes work: a worker long-polls
for work; nothing dials into the VM). Relay gains a work queue keyed by
environment; runner daemon on the VM authenticates with a scoped environment
key, claims sessions tagged `runner`, executes them (Tier-2 executor is the
Claude Agent SDK — see Q6), and streams events back through the existing
kinds (SandboxExec 50, FileWritten 110, TurnCostRecorded 120).

**Where and setup:** Azure VMs (D2as_v5-class; B2s to start) in our VNet.
Bicep template + cloud-init: Node 22, git, runner daemon as a systemd unit;
identity = Entra managed identity; secrets pulled from Key Vault at boot;
**NSG egress rules generated from the agent's environment allowlist** — the
same `networkAllowlist` field, enforced at the network layer instead of the
tool layer; auto-shutdown schedule; one runner pool per org (tenancy
boundary), scale set per concurrency slot. Provisioning is a /wizard script
(credentials + portal steps are human-only).

## 6. Is Atrium an agent harness?

Split the word: a **harness** is the loop around the model (context assembly,
tool schema/execution, gates, streaming); **deployment** is where it runs;
**orchestration** is what Atrium adds above both (channels, goals, pipelines,
inbox, memory gates, audit).

Atrium's dispatcher+driver is a real but deliberately thin harness: it
assembles context (transcript window + gated memory as data blocks), carries
the tool set, blocks on approvals/questions, streams deltas. That is the
right size for chat agents. It is not a coding harness — no compaction, no
skills, no subagents, no file-edit loop — and I should not rebuild Claude
Code.

**Decision: two agent classes.** *Chat agents* run on our thin harness
against the Foundry driver. *Work agents* run the **Claude Agent SDK** —
Claude Code's harness as a library, harness-only, we host — inside Tier-1/2
sandboxes, driven by a `claude-code` driver that mirrors SDK events into the
channel event log. Atrium stays the orchestration + communication + audit
layer over both. (Managed Agents would have been the third option; excluded
by Q4.)

## 7. How do agents get the "proper flow" a Claude Code session has?

Claude Code flow = system prompt + project memory + skills + tools + task
tracking + compaction + subagents. Mapping:

- Have already: foundation prompt (persona), injected reviewed memory,
  transcript window, tool defs, approval gates.
- Work agents inherit the whole flow for free by BEING Agent SDK sessions:
  CLAUDE.md, skills dir, subagents, compaction, todo tracking — mounted from
  the repo the runner clones. Our per-agent YAML becomes the session config.
- Chat agents need only two upgrades to feel session-like: context
  compaction beyond the 30-message window (summarize-into-prefix, or the
  API-side compaction beta when the driver supports it) and per-agent skill
  files injected as data blocks.

## 8. Can agents work the same task simultaneously?

Within one channel, no — by design. Per-channel FIFO with a single in-flight
turn is what keeps a conversation coherent and approvals unambiguous; the
Wave-6 demo showed it serializing goals behind a blocking question, which is
correct behavior, not a bug.

Real concurrency is **decomposition**, exactly as the question suspects:
orchestrator → subtasks → join. The video's review coordinator fanning out
four reviewers is the shape; my pipeline engine is sequential today, so the
pending feature is a **parallel step type**: one step spawns N child
sessions (each its own channel or thread, each its own worktree/sandbox so
two agents never share a working tree), barrier on completion, join step
merges. Guardrails already generalize (session caps count children; spend
cap reads the shared cost ledger).

**How separate is that from individual bot sessions?** Two distinct layers,
keep them distinct:

- **Channel-level multi-agent** (visible): several agents as members, each
  @mention queues a turn; turns alternate, never interleave. Orchestrated
  fan-out happens ABOVE channels — engines spawning child sessions — not
  inside one.
- **Harness-level sub-agents** (invisible): one agent's single turn may
  internally fan out sub-agents if its driver supports it (Agent SDK does).
  The channel sees one turn; the sub-agents live inside the driver.

**So does a bot chat spawn multiple sub-agents, or is it always one bot?**
At the channel layer it is always one bot per turn. Inside a work agent's
turn, the Agent SDK may run many sub-agents. Policy: allow harness-level
fan-out for read-only work (search, review) where only the result matters;
force anything that edits files or spends real money up to the channel/
session layer, where it gets its own event trail, its own approvals, and its
own guardrail line items. Visibility is the product; don't let the
interesting work hide inside a single opaque turn.
