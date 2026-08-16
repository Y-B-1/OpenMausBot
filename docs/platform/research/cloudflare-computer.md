# Cloudflare Computer — Research Report

## 1. What it is

**Cloudflare Computer** (`@cloudflare/computer`, github.com/cloudflare/computer, MIT) shipped as an **open-source preview on August 3, 2026**. Tagline: "Give your agent a computer." It is *not* a VM product — it is a **durable virtual filesystem living inside a Durable Object (DO), with authoritative state in the DO's SQLite**, plus a pluggable execution layer letting agent work run against that one filesystem from multiple runtimes. The repo is explicit: **"PREVIEW ONLY … NOT suitable for production use."**

Distinguish it from two GA'd products:
- **Cloudflare Containers + Sandbox SDK** (`cloudflare/sandbox-sdk`) — the actual isolated Linux environments, **GA April 13, 2026**.
- **Cloudflare Computer** — the experimental "filesystem + runtime router" unifying isolates, containers, and Workers around one persistent workspace.

## 2. Architecture and isolation

- A **Workspace = one Durable Object**; SQLite in the DO is the source of truth for all files (docs/03_filesystem_schema.md; sync protocol docs/02).
- **Single entry point:** `workspace.runtime.exec(source, { backend })`; backends registered under stable IDs, lazily initialized; a workspace with no backend is just a durable filesystem.
- **Three backends:**
  1. **Container backend** — a Cloudflare Container runs `computerd`, exposing the workspace as a **FUSE mount**, syncing bidirectionally with the DO over capnweb RPC. Full Linux userland. The container's VFS is process-lifetime in-memory; only the DO SQLite is durable. The DO is the WebSocket *server*; the container dials back (designed for future WS hibernation).
  2. **Isolate shell backend** — `just-bash` in a Dynamic Worker (V8 isolate) hitting the workspace over Workers RPC — no sync step.
  3. **Isolate JS backend** — ES modules in fresh Dynamic Workers with workspace-backed `node:fs/promises` and trusted `ws:git` / `ws:artifacts` modules.
- **Isolation: V8 isolates + Cloudflare Containers. Not Firecracker, not gVisor.** Most agent work runs in isolates; a real kernel is rented only when needed. E2B/Vercel use Firecracker microVMs, Modal uses gVisor — Cloudflare's container isolation lacks hardware-level kernel separation, which matters for hostile-multi-tenant threat models.
- **Performance** (docs/19): FUSE **beats ext4 on metadata-heavy work** (git init+commit 459 ms vs 635 ms) but **badly trails bulk sequential I/O** (64 MiB write ~17× slower, reads ~30×, copies ~40×); `npm install` ~2× slower (124.7 s vs 63.9 s).

## 3. Capabilities

- **Persistence:** files survive container death, DO eviction, backend switches; worst case a rev-0 baseline rebuild from the DO store.
- Git, assets, artifacts interfaces; AI SDK tool interface; MCP integration; agent integration via `@cloudflare/think`.
- **Browser:** not in the three backends; pair with **Cloudflare Browser Rendering** (managed headless Chromium, Puppeteer/Playwright bindings) — a separate product.
- **Sandbox SDK (GA):** `exec()`, read/write files, background processes, **PTY terminals**, Python/JS code interpreter, port exposure via `*.trycloudflare.com` tunnels (don't survive restart), `sleepAfter`, and **R2-backed full disk+memory snapshots** for instant resume.
- **Cold start:** ~1–3 s containers (snapshots mitigate); isolate backends in milliseconds.

## 4. Pricing (Sandbox/Containers GA)

Requires Workers Paid ($5/mo); active-CPU billing:
- Memory $0.0000025/GiB-s (25 GiB-hrs/mo included)
- vCPU $0.000020/vCPU-s (375 vCPU-min/mo included)
- Disk $0.00000007/GB-s (200 GB-hrs/mo included)
- Egress $0.025/GB NA/EU (1 TB/mo included)
- Up to 15,000 concurrent "lite" instances. Computer itself is open-source; you pay for DO + Container + Worker usage.

## 5. Security model & regions

- Untrusted code per-sandbox in its own container; DO state outside the blast radius; isolate JS gets only trusted `ws:` modules; container egress intercepted (dial-back). GA added **credential injection via outbound Workers** (secrets never enter the sandbox image).
- **Regions:** global placement; pin regions or jurisdictions — `eu` → EEUR/WEUR, `fedramp` → ENAM/WNAM. Worker + DO + R2 + container co-locatable.

## 6. Build-on-it assessment vs E2B / Fly / Modal

- **Pro:** one vendor for edge API, DO agent state, R2 artifacts, sandboxes, browser rendering; active-CPU billing is very cheap for mostly-idle agents; the durable-FS + cheap-isolates model maps well to "thousands of long-lived agents, bursty compute"; snapshots give fast resume.
- **Con:** Computer is preview/unstable; Sandbox SDK still beta; isolation is container-grade, not microVM — weaker for adversarial tenant code; bulk-I/O FUSE penalty hurts big builds; no GPUs; August 2026 reliability wobbles (R2 outages).
- **Positioning:** E2B = purpose-built agent sandboxes (~150–200 ms Firecracker starts); Modal = Python-first gVisor + GPUs; Fly = Firecracker machines you manage, good for per-user persistent VMs but more ops.
- **Pragmatic startup path:** build on **Sandbox SDK (GA)** now, treat **Cloudflare Computer** as the roadmap for durable per-agent workspaces, keep an E2B/Fly escape hatch for high-hostility or heavy-I/O workloads. For this platform specifically: the "durable workspace + disposable compute" split is exactly the Grok-Bot-persistence-without-shared-blast-radius answer — worth adopting as a design pattern regardless of vendor, behind the `SandboxProvider` interface.

Sources: cloudflare/computer repo (README, docs/11, docs/19) · cloudflare/sandbox-sdk · Cloudflare changelogs (2026-08-03 Computer preview, 2026-04-13 Containers/Sandbox GA) · Sandbox SDK docs · InfoQ (Computer; Sandboxes GA) · remio.ai HN-thread analysis (Kenton Varda commentary) · Nerd Level Tech · Blaxel comparison. (blog.cloudflare.com and developers.cloudflare.com were egress-blocked; reconstructed via GitHub primary sources + search.)
