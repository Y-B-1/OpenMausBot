# Secure Linux "Computers" for AI Agents — Research Report

Research for an enterprise-grade multi-agent platform (OpenMausBot context): how to give each agent an isolated Linux machine, what the industry does, and what to build at prototype vs. enterprise scale.

---

## 1. Sandboxing technologies

### 1.1 Isolation spectrum (weakest → strongest)

| Technology | Boundary | Isolation guarantee | Cold start | Overhead/VM | Ops burden |
|---|---|---|---|---|---|
| Plain container + seccomp/AppArmor | Shared host kernel, syscall filter | Weakest — one kernel 0-day = host compromise | ~10–50 ms | ~0 | Low |
| gVisor (runsc) | Userspace kernel intercepting syscalls | Medium — dramatically reduced kernel attack surface, but software boundary, no hardware virt | ~100–200 ms | Low; 10–30% syscall-heavy perf tax | Low–medium (drop-in OCI runtime) |
| Kata Containers | Lightweight VM per pod (KVM/QEMU or Cloud Hypervisor) | Strong — hardware virtualization with OCI/K8s compatibility | ~500 ms–2 s | ~100+ MiB/pod | Medium (K8s RuntimeClass; needs bare metal or nested virt) |
| Firecracker microVM | KVM, minimal VMM (~83k lines of Rust), hardware VT-x/AMD-V boundary | Strongest practical for adversarial multi-tenant; used by AWS Lambda/Fargate | ~125–150 ms boot | <5 MiB VMM overhead | High if self-run (you build snapshotting, networking, orchestration, image pipeline) |

Key points from primary/industry sources:

- **Containers are not sandboxes.** All namespace/cgroup/LSM layers share one kernel; for code an LLM wrote or an adversary injected, treat the container as a convenience layer, not the security boundary. seccomp+AppArmor+no-new-privs+read-only rootfs is fine as *defense in depth inside* a VM, not as the tenant boundary.
- **gVisor** is Google's substrate (GKE Sandbox): cheap to start, great density, container-native, but the boundary is software. Compatibility gaps exist for exotic syscalls, ptrace, some io_uring.
- **Kata** is the right answer when you're already Kubernetes-native and want VM isolation without abandoning pod semantics; heavier and slower than Firecracker but far less custom plumbing.
- **Firecracker** dominates AI-sandbox platforms (E2B, Vercel Sandbox, Codex cloud, Fly Machines). Killer features for agents: **snapshot/restore** (resume a warm VM with dependencies pre-installed in ~100–300 ms), density (thousands of microVMs per host), and a tiny, memory-safe VMM. Cost: requires **bare metal or nested-virt hosts** (KVM access), and you own the control plane: tap/bridge networking, jailer, rootfs images, snapshot storage, scheduling.
- Local coding agents (Claude Code, Codex CLI) converged on **OS-native primitives** — bubblewrap on Linux, Seatbelt on macOS — good for a developer's laptop, insufficient as a multi-tenant server boundary.

### 1.2 Managed sandbox providers

| Provider | Under the hood | Cold start | Pricing model | Notes |
|---|---|---|---|---|
| **E2B** | Firecracker; open-source stack, self-hostable | ~150 ms | ~$0.05/vCPU-hr + $0.016/GiB-hr, billed per second; Pro $150/mo (≈$0.17/hr for 2vCPU/4GiB) | 24 h max sandbox life; persistence via pause/snapshot; SDKs for Python/JS; the default "agent sandbox" choice |
| **Modal** | Own gVisor-based runtime (`Sandbox` API) | 2–4 s CPU; strong for GPU | Pay only while running; idle = $0; GPUs in-sandbox | Python-native serverless; best when agents need GPU or bursty batch |
| **Fly Machines** | Firecracker VMs, raw primitive + REST API | ~2.8 s p50 create (faster on stopped-machine start) | VM-shaped pricing per size, per second | You build the sandbox layer yourself; global regions; good "own control plane without owning metal" middle ground |
| **Daytona** | **Docker/OCI containers by default** (Kata/Sysbox optional add-ons) — RED-TEAM corrected: NOT microVM-based | ~90 ms (fastest in 2026 benchmarks — because it skips the VM boundary) | Similar per-resource metering to E2B | Declarative images, stateful workspaces, self-host option. Weakest default isolation of the named providers — not an E2B substitute for untrusted code |
| **Morph Cloud** | MicroVMs with **VM state branching** (Infinibranch) | ~250 ms incl. full memory-state branch | Usage-based | Unique: fork a running VM (agent tree search / checkpoint-rollback) |

---

## 2. How existing products do it

- **Grok Bot (xAI)**: each *account* (per member on team/enterprise plans) gets one **persistent managed Linux VM** — browser, filesystem, terminal — shared by all of that user's Bots, each Bot getting its own "screen." Persistence is the product: logins, files and browser sessions survive across tasks and Bots. Security caveat widely flagged: isolation is **per account, not per Bot** — any credential one Bot stores is readable by all Bots on the account; screens are UX, not security boundaries. Lesson: **persistent per-user VM = great UX, weak least-privilege**; an enterprise platform should offer per-agent or per-task isolation with an explicit shared workspace, not implicit sharing.
- **OpenAI Codex (cloud)**: each task clones the repo into an **isolated microVM** with its own filesystem/process space and **network disabled by default** (allowlist opt-in). Egress-off is the headline control: dependencies come from a setup phase. Local Codex CLI uses Seatbelt/bubblewrap with a privileged supervisor process deciding per-command policy.
- **OpenAI Operator / ChatGPT Agent**: hosted **sandboxed browser VM**; the CUA model drives mouse/keyboard on screenshots; supervised mode requires user confirmation on sensitive steps (payments, logins) — confirmation-gating as prompt-injection mitigation.
- **Claude Code**: local runs sandbox Bash/filesystem via bubblewrap/Seatbelt with a domain-allowlist network proxy; the cloud offering runs each session in an isolated container/VM per session with egress restricted through an HTTP(S) proxy and a scoped git-credential proxy.
- **E2B-based products**: Perplexity Labs and various code-interpreter features embed E2B Firecracker sandboxes — the pattern is **ephemeral per-task VM, template image with tooling preinstalled, resume-from-snapshot for latency**.

Convergent industry pattern: **microVM per task/session, template snapshots for cold start, egress deny-by-default with allowlists, credentials brokered outside the VM**.

---

## 3. Enterprise data security

1. **Network egress policy** — the single highest-leverage control. Deny-by-default; route all traffic through a filtering forward proxy (domain/CIDR allowlist per tenant and per tool); block IMDS (169.254.169.254) and internal RFC1918 ranges from sandboxes; log every egress request. Egress allowlisting is what turns prompt injection from "data breach" into "failed attempt."
2. **Secrets handling** — secrets must **never enter the VM or the model context**. Use a credential-injection gateway: the sandbox calls `https://proxy/github/...`, and an egress gateway outside the trust boundary attaches the short-lived, scoped token. Short-lived, per-session, least-scope tokens; immediate revocation on session end.
3. **Per-tenant isolation** — hardware-virt boundary (Firecracker/Kata) per sandbox; additionally per-tenant network segmentation, per-tenant encryption keys, per-tenant snapshot/storage namespaces. Never share a warm-pool VM across tenants; scrub or discard snapshot memory between tenants.
4. **Encryption** — at rest: encrypted volumes/snapshots with per-tenant KMS keys; in transit: TLS everywhere including host-boundary APIs; confidential computing (SEV-SNP/TDX) only if the threat model includes the infra operator.
5. **Audit logging** — immutable, append-only logs of: every command executed, every file mutation, every egress request (URL, verb, bytes), every credential use, every human approval. This is the SOC 2 evidence trail and the incident-response substrate. Session recording (terminal + browser) is increasingly expected by enterprise buyers.
6. **Compliance** — SOC 2 Type II / ISO 27001: change management, access reviews, logging over the sandbox control plane. GDPR: data-residency pinning of sandbox hosts/snapshots (EU regions), DPAs with any managed vendor (E2B/Modal become subprocessors — a real procurement friction that favors self-hosting for regulated customers), retention/erasure of session artifacts.
7. **Prompt injection while browsing** — assume the agent *will* be hijacked by page content; design so a hijacked agent can't do damage: (a) egress allowlist bounds exfiltration; (b) no ambient secrets in VM; (c) tool-level least privilege (read-only tokens unless the task needs write); (d) human confirmation gates for irreversible/sensitive actions; (e) treat everything read from the web as untrusted in later tool calls; (f) a policy engine that validates planned actions independently of the model. Prompt-based defenses ("never reveal secrets") are not controls.

---

## 4. Recommendation matrix

| Stage | Recommendation | Why | Rough cost |
|---|---|---|---|
| **Prototype / seed startup** | **Managed E2B** (or Daytona; Modal if GPU needed) | Zero ops, Firecracker isolation out of the box, SDK in a day, snapshot persistence | $150/mo Pro + ~$0.17/hr per 2vCPU/4GiB sandbox; a few hundred $/mo at prototype volume |
| **Growth, cost-sensitive** | **Fly Machines** as the VM primitive, own control plane on top | Firecracker isolation, global regions, per-second billing — without owning metal | Typically 2–4× cheaper than E2B at sustained volume |
| **Scale / self-hosted enterprise (incl. on-prem & data-residency)** | **Firecracker on bare metal** (Hetzner/OVH/OpenMetal or customer's DC) via E2B's open-source self-host stack or own control plane; **Kata on K8s** if the org is deeply Kubernetes-native | Strongest isolation, full data control, 60–80% unit-cost reduction | Crossover ~500–2,000 sandbox-hrs/mo: a ~$115–200/mo bare-metal box replaces $600+/mo of E2B usage; budget 0.5–1 FTE for ops |

**Architecture recommendations regardless of stage:**

1. **One microVM per agent-task** (ephemeral) plus an explicit, opt-in **shared persistent workspace volume** per user/team — Grok Bot's continuity UX without its account-wide credential blast radius.
2. **Egress deny-by-default** through a filtering proxy from day one — retrofitting is much harder than starting closed.
3. **Credential broker outside the VM**; nothing reusable inside the sandbox.
4. **Snapshot/template pipeline** for <300 ms perceived starts.
5. **Design a "SandboxProvider" interface** now (create/exec/snapshot/destroy) so you start on E2B and swap to self-hosted Firecracker for enterprise deals without touching agent code — dual-mode (managed for SMB, self-hosted for regulated enterprise) is itself a sales differentiator.
6. **Human-approval gates + full session audit recording** before selling to enterprises; buyers ask for these before they ask about hypervisors.

## Sources

- Edera: Kata vs Firecracker vs gVisor · microVM isolation 2026 survey · Northflank runtime comparison
- E2B docs/pricing · Northflank E2B vs Vercel Sandbox · ZenML E2B alternatives
- LogRocket E2B/Modal/Daytona comparison · AgentMarketCap sandbox infra 2026 · Modal sandbox survey · Morph vs Daytona
- xAI Grok Bot docs (overview, computer & apps) · TechTimes on the shared-computer caveat
- Codex sandboxing (Cobus Greyling) · Claude Code & Codex sandbox internals · Operator/ChatGPT Agent overview
- NVIDIA sandboxing agentic workflows · agentgateway credential injection · TrueFoundry prompt-injection guide · Atlan prompt-injection 2026
- bex.co self-hosting cost crossover · OpenMetal bare-metal sandbox guide · Spheron Firecracker setup guide
