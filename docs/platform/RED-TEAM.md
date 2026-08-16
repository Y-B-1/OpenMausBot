# Red-Team Verification of Platform Research (2026-08-16)

Nine adversarial fact-check agents, one per research doc. Each extracted the 6–10 load-bearing claims and tried to refute them against primary sources (codebase claims verified directly against the code). Corrections below are authoritative over the original docs; the flat-wrong claims have also been patched in place.

## Verdict summary

| Doc | Result | Material corrections |
|---|---|---|
| grok-bot.md | 8/9 confirmed | Pricing nuance (see below) |
| tiered-memory.md | 7/10 confirmed | Type quotes unverified; Mem0 pipeline stale; GDPR gap |
| promptql-openclaw-hermes.md | 6/9 confirmed | ClawHavoc figure; PromptQL pricing outdated |
| vm-sandboxing-security.md | mostly confirmed | **Daytona REFUTED**; self-host crossover math weak |
| model-strategy.md | mostly confirmed | **"Bedrock-only EU residency" REFUTED**; Kimi ranking stale |
| type-com.md | honest but over-claimed | Three-tier memory + self-review downgraded to unverified |
| openmausbot-codebase-map.md | every checkable claim survived | Two softenings only |
| buzz-code-study.md | architecture facts near-verbatim | **"No rate limiting" REFUTED**; ACP default is Drop |
| cloudflare-computer.md | facts/dates/pricing right | **Isolation assessment challenged**; FUSE multipliers inflated |

## Refuted / corrected claims (design-relevant)

1. **Daytona is NOT microVM-based by default** — it achieves ~90 ms cold starts with standard Docker/OCI containers sharing the host kernel (Kata/Sysbox optional). Do not treat it as an E2B-equivalent isolation boundary. → E2B stays the prototype sandbox pick.
2. **Bedrock is NOT the only EU-residency path for Claude** — Vertex AI EU regions (e.g. europe-west3) also qualify. Corrected claim: EU residency for Claude exists **only via hyperscalers (Bedrock EU profiles or Vertex EU regions)**, never via the first-party API or Foundry (EU "coming 2026").
3. **Buzz DOES enforce rate limiting at HEAD** — a Redis-backed atomic Lua INCR+EXPIRE limiter is live in the admission path (buzz-pubsub/src/rate_limiter.rs; state.rs:855; connection.rs:666/689). Real caveat: fixed-window allows 2× burst at boundaries.
4. **Buzz ACP default in-flight policy is Drop, not Queue** — queue-and-batch (max 50 events/batch) is opt-in. A platform copying the per-channel single-in-flight model must choose drop-vs-queue explicitly.
5. **Cloudflare Containers isolation** — Cloudflare's own docs state each container instance runs in its own dedicated VM; "lacks hardware-level kernel separation" is not supportable (hypervisor undisclosed). The E2B-vs-Cloudflare security tradeoff is narrower than the doc claimed. FUSE slowdowns are 13.7×/17.1×/26×, not 17×/30×/40×; tmpfs baseline (Sandbox SDK today) is ~3.6× faster than FUSE for npm install.
6. **ClawHavoc figure** — primary source (Koi Security): 341 malicious skills of 2,857 audited (~12%), not "800+/~20%". Conclusion (unsigned registries are attack surfaces) unchanged.
7. **PromptQL pricing** — no longer purely sales-gated: public consumption pricing (~$0.042/program) + BYO LLM key (Anthropic/Bedrock/Vertex). Enterprise still contact-sales.
8. **Type's three-tier memory + self-review loop** — the anchor quotes could not be reproduced from any indexed source; treat as plausible reconstruction/marketing, not verified product fact. Our Org/Space/Personal design stands on the surveyed systems (Letta, Zep, Mem0, Supermemory, Honcho, Claude Code) on its own merits.
9. **Mem0 pipeline stale** — Mem0 reportedly moved to single-pass ADD-only extraction (retreating from auto-DELETE), which *strengthens* our reversibility requirement. The 0.3×–1.5× decay figure is unverified.
10. **Grok Bot pricing nuance** — subscriptions include a weekly usage allowance; the "uncapped meter" is overage (no spend cap). Grok 4.6 doubles rates above 200K tokens. Identity/billing/compliance run through Cursor (Anysphere). Deleting a Bot does not remove its files/sign-ins from the shared computer. Group chats cap at 2–6 bots.
11. **Firecracker LOC** ~50k (official), not 83k. **Fly-vs-E2B cost gap** larger than 2–4× on raw compute at small sizes. **Self-host crossover math** is single-blog-sourced and omits the dominating 0.5–1 FTE ops cost — treat as marketing math; crossover is much higher in practice.
12. **Hermes audit vs CVEs** — the 4C/9H audit (Apr 2026) and "9 CVEs in 4 days" (May 2026) are two separate events; approval-skip also covers singularity backend.
13. **Codebase map softenings** — upstream's no-CORS posture is deliberate (blocks cross-origin reads, not simple POSTs); reloadProviders() is guarded (fires only on non-profile/tts changes) and settles stranded bots.

## Red-team-surfaced gaps to carry into design

- **GDPR right-to-erasure vs "never hard-delete" memory** → need crypto-shredding / true-delete escape hatch, retention schedules, legal hold, and offboarding semantics for personal→space contributions.
- **CSRF on localhost** — upstream's unauthenticated REST on 127.0.0.1 is drivable by any web page via simple POSTs; even "local mode" needs auth.
- **Prompt-injection in rooms** — group bulletins, roster names, and peer-bot replies fold into other bots' context untreated; needs the data-not-directives wrapping everywhere.
- **Buzz identity gap** — raw keypairs have no SSO/OIDC/SCIM, rotation, or recovery story; enterprise identity must wrap or replace protocol identity, and agents must be auditable *differently* from humans.
- **Cloudflare Computer limits** — ~10 GB workspace cap shared with DO storage; DO single-threaded write ceiling; Aug 2026 incident cluster (13 incidents). Sandbox SDK claims (R2 snapshots, credential injection) unverified against blocked primary docs.
- **Side-channel posture on self-hosted bare metal** — Spectre/MDS-class cross-tenant risk requires SMT-off or per-tenant core pinning; a real cost multiplier omitted from crossover math.
- **Buzz remote-agent self-reap has no guaranteed kill switch** (their own honest-costs admission) — an enterprise platform needs a substrate-level bounded-lifetime backstop (namespace TTL equivalent) as a hard requirement, not an optimization.
- **Anthropic Managed Agents** never evaluated as a build-vs-buy alternative for the orchestrator tier.
- **BYO-subscription ToS risk** — consumer Claude/ChatGPT plan terms restrict multi-user programmatic sharing; the Type-style BYO wedge may sit in a ToS gray zone. Design BYO around API keys / enterprise plans, not consumer subscriptions.
- **Memory evals** — need task-success A/Bs and LongMemEval-style regression to detect harmful consolidations; also see arXiv 2606.18829 (GateMem), 2606.24535 (Governed Shared Memory), 2607.02579 (When Not to Write Memory).
- **Kimi K2.6 ranking stale** (≈45 on current AA index, below DeepSeek V4 Flash) — re-benchmark before any self-host model pick.
