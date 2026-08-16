# LLM Model Strategy for an Enterprise Multi-Agent Chat Platform (mid-2026)

Research date: 2026-08-16. Anthropic pricing from Anthropic's current model catalog; other providers from mid-2026 pricing surveys and vendor pages (sources at end).

---

## 1. API Model Landscape & Perf/Cost Tiers

### 1.1 Anthropic (Claude 5 family) — first-party API list prices

| Model | ID | Context | $/1M in | $/1M out | Role in a multi-agent platform |
|---|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10 | $50 | Frontier tier for the hardest long-horizon agentic work; thinking always on; requires 30-day retention (no ZDR) |
| Claude Opus 5 | `claude-opus-5` | 1M | $5 | $25 | **Default orchestrator / coding agent.** Strongest agentic coding per dollar; fast mode at $10/$50 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5 | $25 | Prior-gen Opus; recommended refusal-fallback target for Fable/Opus 5 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3 ($2 intro to 2026-08-31) | $15 ($10 intro) | **Default worker agent.** Near-Opus quality; sweet spot for per-channel agents and RAG synthesis |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3 | $15 | Stable prior-gen worker |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 | Cheap classifier/router, sub-agent reading, extraction |

Platform-design notes: prompt caching (reads ~0.1×, writes 1.25×/2×) and Batch API (−50%) materially change effective cost with big shared system prompts; adaptive thinking + `effort` (`low`→`max`) is the main quality/cost dial; Fable 5/Opus 5 need `stop_reason: "refusal"` handling and benefit from server-side `fallbacks`.

### 1.2 OpenAI
GPT-5.6 family (GA July 2026): **GPT-5.6 Sol** $5/$30 (frontier/orchestrator), **GPT-5.6 Terra** $2/$12 (worker), **GPT-5.6 Luna** $0.20 input (cheap tier), after a July 30 price cut. Long-context requests carry separate higher meters. Strength: mature Assistants/Responses tooling; weakness: pricing volatility across releases.

### 1.3 Google Gemini
**Gemini 3.1 Pro / 3 Pro**: $2/$12 (rising to $4/$18 above 200K input). **Gemini 3.7 Flash** (Aug 2026): intro $0.75/$3.75; **3.6 Flash** $1.50/$7.50; **3.5 Flash-Lite** $0.30/$2.50; **2.5 Flash-Lite** floor $0.10/$0.40. Batch −50%, cache reads 10%. Long-context and multimodal strength make Flash tiers excellent RAG readers; watch un-budgeted thinking-token spend.

### 1.4 xAI Grok
**Grok 4.6** (Aug 2026): $2/$6 (<200K), $4/$12 above, cached input $0.50. **Grok 4.3**: $1.25/$2.50; **Grok Build 0.1** (coding) $1/$2; **Grok 4 Fast** $0.20/$0.50. Very cheap output; strong high-volume tool-calling workers; less common in regulated-enterprise compliance stacks.

### 1.5 DeepSeek
R1 folded into V4 thinking mode. **V4 Flash**: $0.14/$0.28 — cheapest frontier-class API; **V4 Pro**: $1.74/$3.48. Cache hits 1/10 input. For a US/EU financial firm the hosted API is usually excluded on data-governance grounds, but the open weights are a legitimate self-host candidate.

### 1.6 Open-weight leaders (mid-2026)
- **Kimi K2.6** (Moonshot) — top open model on Artificial Analysis (~54, #1 open / #4 overall); MoE, heavy VRAM.
- **DeepSeek V4 Pro** (open weights) — ties closed frontier on SWE-Bench agentic coding.
- **GLM-5.1** (Zhipu) — cleanest MIT license among frontier open models; strong agentic coding.
- **Qwen 3.x** (Alibaba) — Qwen3.6-27B best small dense coder, Apache-2.0; safest commercial license family, full size ladder.
- **Llama 4** (Meta) — Scout for ultra-long context (10M); Maverick general chat; "Muse Glimmer" 30B (Aug 2026) strongest tool-caller in class.
- **Mistral Medium 3.5 / Small** — EU vendor, EU-friendly contracts.
- **Gemma 4 26B / Phi-4** — best small local models for cheap classifiers.

Reality: open weights are no longer "second best" — four of the top five are from Chinese labs, which matters for procurement optics in finance even when self-hosted (weights are static artifacts, so the risk is mostly reputational/licensing, not data egress).

### 1.7 Tiering pattern for the platform

| Tier | Job | API picks | Open-weight picks |
|---|---|---|---|
| Orchestrator / coding agent | Planning, multi-step tool use, code | Claude Opus 5, GPT-5.6 Sol, Gemini 3.1 Pro | DeepSeek V4 Pro, Kimi K2.6, GLM-5.1 |
| Worker / channel agent, RAG synthesis | Per-channel chat, doc Q&A | Claude Sonnet 5, GPT-5.6 Terra, Grok 4.3 | Qwen3 32–70B class, Llama 4 Maverick |
| Cheap classifier / router / extractor | Intent routing, tagging | Claude Haiku 4.5, Gemini Flash-Lite, GPT-5.6 Luna, Grok 4 Fast, DeepSeek V4 Flash | Qwen3-8B, Gemma 4, Muse Glimmer 30B |

---

## 2. Self-Hosting for Enterprise

### 2.1 Serving engines
- **vLLM** — the default: mature, largest ecosystem, PagedAttention, OpenAI-compatible server, best for large-batch 70B+ serving.
- **SGLang** — ~29% higher throughput on H100s for prefix-heavy workloads (agents, RAG, long shared system prompts) via RadixAttention prefix caching; gap narrows to 3–5% on 70B+. Best fit for exactly this product.
- **TGI** — moved to **maintenance mode Dec 2025**; do not adopt.
- **TensorRT-LLM** — highest peak perf on NVIDIA, heavy compile/ops burden.
- **Ollama / llama.cpp** — dev laptops and prototyping only.

### 2.2 Hardware sizing (rules of thumb)

| Model class | Precision | GPUs | Notes |
|---|---|---|---|
| 7–8B (classifier/router) | FP8/INT4 | 1× L40S / A10G 24–48GB | Thousands of req/min with prefix caching |
| 30–34B | FP8 | 1× H100 80GB (or 2× A100 40GB) | Good worker tier |
| 70B-class | FP8 | 1× H100 (tight) or 2× H100; BF16 needs 2–4× 80GB | ~70GB weights at FP8; dual-H100 holds ~20ms TPOT |
| 70B low-concurrency | INT4 (AWQ/GPTQ) | 1× 80GB | Quality haircut; fine for internal tools |
| MoE frontier (DeepSeek V4, Kimi K2.6) | FP8 | 8× H100/H200 node minimum | Only worth it at large sustained volume |

Add ~15–30% VRAM headroom for KV cache; KV cache, not weights, is the binding constraint for 100K+-context RAG agents.

### 2.3 Managed private cloud — the middle path for a financial firm
For data-residency-sensitive enterprises, the pragmatic answer is usually **frontier models through a hyperscaler's private endpoint**, not GPUs:

- **AWS Bedrock** — partner-operated Claude, plus Llama/Mistral; guaranteed EU data residency for Claude via EU Inference Profiles; PrivateLink, CloudTrail audit, no training on your data. The default for regulated FS. (RED-TEAM corrected: EU residency for Claude is **hyperscaler-only — Bedrock EU profiles OR Vertex AI EU regions such as europe-west3** — never the first-party API or Foundry.)
- **Claude Platform on AWS** — Anthropic-operated with same-day API parity, SigV4/IAM auth, Marketplace billing. Best of both when you want the full Anthropic feature surface with AWS-native controls.
- **Azure OpenAI / Microsoft Foundry** — GPT-5.x with Azure tenancy, plus Claude GA on Foundry — but **no EU data zone for Claude on Foundry yet** ("coming 2026"); EU FS firms can't use it for personal data today.
- **GCP Vertex AI** — Claude, Gemini, and open models with CMEK, VPC-SC, EU regions. Note Anthropic feature gaps on Bedrock/Vertex: no Batches, Files API, code execution, web fetch, or Managed Agents — feature-sensitive traffic may need the first-party API.

---

## 3. Routing Architecture

**Recommended: self-hosted, model-agnostic gateway + direct SDKs for provider-specific features.**

- **LiteLLM (proxy mode)** — MIT, self-hostable, 100+ providers behind one OpenAI-compatible API; **per-key/user/team/org spend attribution**, tag-based budgets, virtual keys per tenant/agent, Langfuse/OTel export, message redaction. The reference choice when data cannot leave your infra. Break-even vs managed gateways ~$3.6K–$9K/mo model spend.
- **OpenRouter** — fastest way to get every model with one key; but aggregate-only cost tracking, traffic transits their infra, third-party data processor — a hard no for regulated tenants; fine for the startup prototype.
- **Vercel AI Gateway + AI SDK** — hosted unified endpoint with budget controls and latency-ranked fallback (rescued ~3.5% of requests in published production data); the AI SDK is an excellent TypeScript abstraction even pointed at your own LiteLLM.
- **Direct SDKs, no LangChain** — for the coding-agent and orchestrator paths call `@anthropic-ai/sdk` / `openai` directly. Gateways flatten to OpenAI-compatible shapes and lose provider-native features: adaptive thinking/`effort`, `cache_control` placement, server-side fallbacks, tool runner. Sane split: fungible worker/classifier traffic through the gateway; orchestrator traffic through native SDKs.

**Per-agent model selection**: store a `model_policy` on each agent definition (model ID, effort, max spend, fallback chain, allowed data-residency class), resolved at request time. **Fallback**: provider-level (429/5xx → same model on Bedrock/Vertex mirror) and model-level (refusal/outage → next model in chain). **Cost tracking**: virtual key per (tenant × agent), gateway usage events into billing; reconcile monthly against provider invoices (gateway estimates drift on cached/thinking tokens).

---

## 4. Recommendation Matrix

| Dimension | Startup prototype (BYO keys) | Enterprise private-cloud (recommended for a financial firm) | Enterprise self-hosted |
|---|---|---|---|
| Model access | Direct APIs or OpenRouter; users bring keys | Bedrock (+ Claude Platform on AWS) primary; Azure/Vertex secondary | vLLM/SGLang cluster, open weights |
| Orchestrator | Claude Opus 5 / GPT-5.6 Sol | Claude Opus 5 via Bedrock | DeepSeek V4 Pro or Kimi K2.6 (8×H100) |
| Worker agents | Claude Sonnet 5 / Gemini 3.7 Flash | Claude Sonnet 5 (Bedrock) | Qwen3-32B / Llama 4 Maverick, FP8, 1–2× H100 |
| Classifier/router | Haiku 4.5 / Flash-Lite / V4 Flash | Haiku 4.5 (Bedrock) | Qwen3-8B or Gemma 4 on 1× L40S |
| Gateway | Vercel AI SDK or OpenRouter | Self-hosted LiteLLM in VPC + native SDKs for orchestrator | Same LiteLLM → internal vLLM endpoints |
| Data residency | None guaranteed | Contractual (EU inference profiles, PrivateLink, no-training) | Absolute |
| Ops burden | ~zero | Low (IAM, quotas, monitoring) | High (GPU fleet, engine upgrades, per-swap evals) |
| Cost ballpark | $50–$500/mo | ~list price: 1,000 seats at ~2B in / 200M out tokens/mo on Sonnet-5-class mix ≈ $9–15K/mo before caching (caching + Haiku routing typically cuts 40–60%) | 2×H100 node ≈ $4–6K/mo rented per 70B worker; 8×H100 ≈ $18–30K/mo — beats API only above ~3–5B steady output-heavy tokens/mo, plus 1–2 FTEs MLOps |

### Bottom-line recommendations

1. **Default posture for the enterprise/financial deployment: private-cloud (Bedrock + Claude Platform on AWS), not GPUs.** Frontier Claude with EU residency, IAM and audit at API prices, no fleet ops. Self-hosting only wins at very large, steady, output-heavy volume or an absolute no-egress mandate.
2. **Three-tier model policy everywhere**: Opus-5-class orchestrator → Sonnet-5-class workers → Haiku-4.5-class classifiers. Route ~70–85% of raw calls to the bottom two tiers — the single biggest cost lever, ahead of any infra choice.
3. **Gateway = self-hosted LiteLLM** for fungible traffic + per-tenant/agent virtual keys and budgets; **native Anthropic SDK** for the coding/orchestrator path (keeps prompt caching, effort control, tool runner, server-side fallbacks). Avoid OpenRouter for regulated tenants; avoid TGI entirely.
4. **If/when self-hosting**: SGLang for prefix-heavy agent workloads, vLLM for 70B batch; FP8 on H100s default; Qwen3 (Apache-2.0) license-safe family, GLM-5.1 (MIT) or DeepSeek V4 Pro for peak open coding quality.
5. **Written exit path**: per-agent model policies in config so any tier can be re-pointed (API ↔ Bedrock ↔ self-hosted) without app changes.

Sources: CloudZero (OpenAI/Gemini/DeepSeek pricing) · BenchLM · AI Pricing Guru · Curlscape Gemini guide · pricepertoken Grok · Codersera & Tech-Insider open-LLM landscape 2026 · Spheron H100 benchmarks · BuildMVPFast vLLM vs TGI · Iternal on-prem GPU sizing · RelayPlane & Maxim AI gateway comparisons · Vercel AI Gateway vs OpenRouter · InfoQ Claude-on-Foundry GA · Anthropic regional-compliance page · Anthropic model catalog & platform-availability matrix.
