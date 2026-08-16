# Expert Briefing: PromptQL, OpenClaw, and Hermes Agent
### Comparative platform research for an enterprise multi-agent chat superapp — August 2026

---

## 1. PromptQL (Hasura)

### Concept
PromptQL is Hasura's pivot from GraphQL middleware to an enterprise "agentic data access" platform. Its core thesis: letting an LLM answer questions about enterprise data directly (text-to-SQL, RAG, or probabilistic tool-calling) is architecturally unreliable at scale. Instead, the LLM should **write a plan, not compute the answer**. PromptQL uses the model to generate a multi-step *query plan* in a constrained DSL (Python + SQL steps), then executes that plan deterministically in a runtime *outside* the model. Hasura markets this as "100% accuracy" — the company itself concedes the honest framing is **100% repeatability**: the same plan yields the same answer every time because computation happens in code, not in token sampling. They've published pointed critiques of "probabilistic tool selection" (i.e., vanilla MCP-style tool-calling) as an architectural dead end for high-stakes data work.

### Architecture
- **Supergraph / DDN (Data Delivery Network)**: a unified semantic metadata layer over all data sources. Subgraphs represent business domains (users, orders, billing), each bundling connectors, models, commands, relationships, and permissions. Cross-source relationships are first-class — you can join Postgres to a SaaS API and reason across both.
- **Connectors**: native support for PostgreSQL, MySQL, SQL Server, Oracle, Snowflake, Redshift, BigQuery, MongoDB, Databricks, plus HTTP/API sources and MCP interop.
- **Semantic metadata in HML** (Hasura Metadata Language, declarative YAML): description fields on models/commands/relationships give the planner business context. Metadata uses an **immutable build system** — PromptQL always runs against a versioned snapshot of the supergraph, so behavior is auditable and reproducible.
- **Planner + deterministic runtime**: the LLM emits a step-by-step plan; a distributed query engine executes it across federated sources, enforcing **fine-grained, row/field-level authorization** at execution time. Artifacts (tables, visualizations) are produced by code, so the LLM never fabricates numbers.
- **Compliance posture**: SOC 2 Type II, HIPAA, GDPR, ISO 27001.

### Strengths
- The plan/execute split is the strongest available answer to hallucinated analytics: numbers come from executed code, the plan itself is inspectable, and re-runs are deterministic.
- Authorization lives in the data layer, not the prompt — permissions can't be prompt-injected away.
- Versioned, declarative metadata gives enterprises change control and auditability that agent frameworks lack entirely.
- Federated joins across heterogeneous sources without ETL.

### Weaknesses
- Heavy upfront modeling cost: someone must build and maintain the supergraph and semantic descriptions; accuracy is bounded by metadata quality.
- Sales-gated, opaque pricing; no self-serve trial; bundled LLM rates limit negotiation.
- Weak distribution: it lives in its own interface rather than embedding into Slack/Teams — insights stay siloed.
- The "100% accuracy" marketing invites skepticism; plan *generation* is still probabilistic — a wrong-but-repeatable plan is confidently wrong.
- Young platform (2024 launch), thin community footprint versus open frameworks.

### Ideas worth merging into the superapp
1. **Plan-then-execute as the data-access contract**: any agent answering quantitative questions should emit an inspectable, replayable plan executed by a deterministic engine — never inline LLM arithmetic.
2. **A versioned semantic layer** (immutable builds) as the shared source of truth for all agents, so every agent speaks the same business vocabulary and behavior changes are diffable and roll-back-able.
3. **Authorization enforced at the execution layer**, keyed to the end user's identity, not the agent's — the model literally cannot retrieve data the user can't see.
4. **Plan artifacts as chat objects**: surface the query plan alongside the answer so analysts can audit, edit, pin, and re-run it — turning one-off answers into reusable, governed assets.

---

## 2. OpenClaw (formerly Clawdbot / Moltbot)

### Concept
OpenClaw is Peter Steinberger's open-source personal AI assistant — started as a weekend side project in November 2025, renamed twice after trademark disputes, and now one of the fastest-growing repositories in GitHub history (~247k stars, ~47k forks by March 2026). The pitch: a private, self-hosted, model-agnostic agent that lives in the messaging apps you already use, runs on your own machine, and *actually does things* — shell, files, browsers, calendars — rather than just chatting. Steinberger joined OpenAI in February 2026; the project moved to an independent foundation and remains open source.

### Architecture
Three-layer hub-and-spoke:
- **Channel adapters**: WhatsApp, Telegram, Discord, Signal, iMessage, Slack, and a dozen more messaging surfaces normalize traffic into a common frame format.
- **Gateway daemon**: the hub. Routes frames between channels and agents, owns the **cron/heartbeat scheduler** (enabling proactive behavior — the agent messages *you*), persists sessions, and exposes a control plane (often a WebSocket API on localhost).
- **Agent runtime**: calls frontier or local models (bring-your-own-key, fully model-agnostic) and invokes **AgentSkills** — 100+ markdown-plus-scripts capability packs (shell execution, filesystem, web automation) distributed through the community ClawHub registry.

### Strengths
- Best-in-class channel ubiquity: meeting users inside WhatsApp/Telegram/Signal is the single biggest driver of its virality — zero-new-app adoption.
- The gateway/agent separation is a clean, reusable pattern: channels, orchestration, and cognition are independently swappable.
- Proactive scheduling (cron + heartbeat) makes it an assistant, not a chatbot.
- Skills-as-markdown is a radically low friction extension model; enormous community ecosystem.
- Privacy/local-first stance and model agnosticism.

### Weaknesses (severe, and instructive)
- **Microsoft formally classified it as untrusted code execution with persistent credentials.** The lethal trifecta — private data access, untrusted input, arbitrary execution — is its default configuration.
- **135,000+ exposed instances** were found on the public internet, thousands vulnerable.
- **Supply-chain catastrophe**: the "ClawHavoc" attack planted 800+ malicious skills in ClawHub (~20% of the registry); Cisco's audit found vulnerabilities in 26% of the catalog, including the top community skill ("What Would Elon Do?") which was functional malware — nine flaws, two critical, silent curl-based exfiltration plus direct prompt injection. Cisco built an entire product (DefenseClaw) in response.
- Documented data-leakage and indirect prompt-injection classes (Giskard, CSA, arXiv "Taming OpenClaw").
- Single-tenant, personal design: no org-grade identity, audit, or policy layer.

### Ideas worth merging into the superapp
1. **Adopt the gateway pattern wholesale**: one hub daemon, N channel adapters, M agents — this is precisely the skeleton an enterprise chat superapp needs, with the channels being Teams/Slack/email instead of WhatsApp.
2. **Proactive cron/heartbeat scheduling** as a first-class primitive (digests, watchdogs, follow-ups).
3. **Skills as a marketplace — but with everything OpenClaw lacked**: signed provenance, mandatory automated scanning (a Skill Scanner in CI), permission manifests per skill, and admin-curated allowlists. OpenClaw is the definitive case study that an unsigned community skill registry is an attack surface, not a feature.
4. **Session persistence keyed to the person across channels**, so a conversation started in Slack continues in email.
5. Anti-pattern to bake in from day one: never expose the control plane; default-deny egress; per-agent credential vaulting instead of ambient persistent credentials.

---

## 3. Hermes Agent (Nous Research)

### Disambiguation
"Hermes" at Nous Research names two things: the **Hermes model series** (Hermes 2/3/4 — open-weight, function-calling-tuned LLMs) and, since February 2026, **Hermes Agent** — an MIT-licensed autonomous agent *framework* (github.com/NousResearch/hermes-agent, ~231k stars, 46k forks). The framework is the relevant agent-platform meaning and the focus here; it is model-agnostic (Nous Portal, OpenRouter, OpenAI, custom endpoints), not tied to Hermes models.

### Concept
Hermes Agent's differentiator versus OpenClaw/LangChain is a **self-improvement loop**: no task is an isolated event. Completed tasks feed a structured feedback pipeline that distills solution paths into named, reusable **skills**; the next similar task short-circuits exploration by loading the skill. Combined with persistent memory of successes and failures, the agent measurably gets better at *your* recurring work.

### Architecture
- **Messaging gateway**: Telegram, Discord, Slack, WhatsApp, Signal, Email, CLI from a single gateway process, with cross-platform conversation continuity and voice transcription (v0.20 added streaming conversational voice).
- **Memory**: agent-curated memory with periodic nudges; FTS5 full-text session search with LLM summarization for cross-session recall; user modeling via Honcho.
- **Skills**: autonomous skill creation after complex tasks; skills self-improve during use; interop with the agentskills.io open standard; a Skills Hub registry.
- **Execution backends**: seven terminal backends — local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox — from $5 VPS to serverless.
- **Orchestration**: cron scheduler, **subagent spawning** for parallel workstreams, MCP integration, batch trajectory generation (for training data), and as of v0.20: **A2A v1.0 agent-to-agent collaboration**, signed outbound webhooks, and grounded research with verifiable citations.
- **Security controls**: command approval, DM pairing, container isolation. Ferocious velocity: v0.19→v0.20 alone saw ~3,650 commits from 650+ contributors.

### Strengths
- The skill-distillation loop is the most interesting idea in the open agent space: compounding capability instead of stateless sessions.
- Broadest deployment flexibility (seven sandboxes) of any popular framework.
- A2A collaboration, signed webhooks, and citation-grounded research show a maturing, standards-oriented trajectory.
- Massive contributor base and release cadence.

### Weaknesses
- **Skill poisoning is the flagship risk**: a prompt injection during one session can be distilled into a skill — persisted to disk as Markdown and loaded as *trusted context* in future tasks. Memory-poisoning was theorized in 2024; Hermes is the first popular framework where the vulnerable pattern is default behavior. CSA documented persistent execution surviving restarts via poisoned memory/skills/MCP.
- Audit of v0.8.0 defaults: **4 Critical / 9 High** findings — default local shell execution, regex-based (bypassable) dangerous-command detection, unrestricted `read_file` (SSH keys, .env), and — remarkably — approval checks *unconditionally skipped* when running in docker/modal/daytona backends. Plus a prompt-injectable auto-approval mechanism, opt-in (not default) write sandbox, and unsandboxed plugin/hook loading. Nine CVEs landed in four days (May 2026).
- Signed skill provenance, enterprise approval workflows, and audit trails remain unresolved; velocity outpaces security review.

### Ideas worth merging into the superapp
1. **Skill distillation with governance**: capture the compounding-learning loop, but make distilled skills *proposals* — quarantined, diffed, security-scanned, and human/policy-approved before entering the trusted context. Provenance-tag every skill with the session that created it.
2. **Tiered memory with trust levels**: retrieved memory should never carry instruction-level authority — treat it as data, not directives.
3. **Pluggable execution backends** behind one interface — lets enterprise ops choose isolation level per agent/tenant.
4. **A2A + signed webhooks** as the inter-agent contract for the multi-agent layer, and **subagent spawning** for parallel work.
5. **Grounded answers with verifiable citations** as a hard output requirement, mirroring PromptQL's determinism goal from the retrieval side.

---

## Synthesis: the superapp blueprint
The three platforms decompose cleanly into layers: **OpenClaw contributes the body** (gateway + channel adapters + proactive scheduling + session continuity), **Hermes contributes the mind** (persistent memory, skill distillation, subagents, A2A), and **PromptQL contributes the conscience** (deterministic plan-execution over a versioned semantic layer with execution-time authorization). The unifying negative lesson is equally clear: both open frameworks demonstrate that ungoverned skills/memory are persistent injection vectors and that permissive execution defaults get catalogued by Microsoft, Cisco, and the CSA. An enterprise superapp should therefore invert every default — signed skills, default-deny execution, trust-tiered memory, identity-scoped data authorization — while adopting the architectural patterns above.

Sources: [PromptQL accuracy blog](https://promptql.io/blog/how-promptql-achieves-100-accuracy-for-ai-on-enterprise-data), [PromptQL supergraph docs](https://promptql.io/docs/project-configuration/supergraph/), [eesel PromptQL analysis](https://www.eesel.ai/blog/promptql), [camelAI on PromptQL limitations](https://camelai.com/blog/promptql-alternatives-ai-data-query-tools), [Cisco: personal AI agents security nightmare](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare), [Cisco DefenseClaw](https://blogs.cisco.com/ai/cisco-announces-defenseclaw), [AuthMind on ClawHavoc](https://www.authmind.com/blogs/openclaw-malicious-skills-agentic-ai-supply-chain), [CSA indirect prompt injection note](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/06/CSA_research_note_openclaw_indirect_prompt_injection_20260613-csa-styled.pdf), [DigitalOcean OpenClaw overview](https://www.digitalocean.com/resources/articles/what-is-openclaw), [NousResearch/hermes-agent repo](https://github.com/NousResearch/hermes-agent), [hermes-agent releases](https://github.com/NousResearch/hermes-agent/releases), [Hermes security audit issue #7826](https://github.com/NousResearch/hermes-agent/issues/7826), [CSA Hermes CVE note](https://labs.cloudsecurityalliance.org/research/csa-research-note-hermes-agent-cves-20260504-csa-styled/), [aiengineerinsights Hermes guide](https://aiengineerinsights.com/blog/hermes-agent-nous-research-guide/).
