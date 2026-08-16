# Study: Danny Postma's "AgentOS" video + Atrium design direction

**Source:** "How I Built My Own AgentOS on Claude's Agent SDK (So You Can Too)"
— Danny Postma, YouTube `Tos-zPxYPuc`, 26 min, watched 2026-08-16 (transcript
from native captions + ~90 frames). Owner directive: mine it for Atrium
features; design must be a **cross of type.com's visual language and the
OpenMausBot app** (see §4).

---

## 1. The system in the video (what it is)

One person's private agent platform, built over ~6 months **on Anthropic's
cloud-managed agents API** (his UI + API on top of it; recently added a $10
Hetzner VM as a local runner tier). It runs "95%" of his coding and much of
his business ops. Sidebar map of the product: Inboxes, Activity, Tasks, Goals,
Sessions, Costs, Skills, Environments, Agents, Templates, Files, Knowledge,
Repos, Connections, Admin.

Core loop (his own diagram, 03:30): **You set a goal → goal breaks into tasks
(todo → doing → review → done) → each task runs an agent in a throwaway cloud
container → agent has skills + knowledge + files → contacts you only via an
inbox → you reply, agent resumes → done.**

Load-bearing mechanics, with timestamps:

- **Agents as configs (03:39–06:35).** Each agent = name, model, prompt
  (shared "AgentOS Foundation" prompt + role prompt), toggled capabilities,
  skills, MCP connections, repos, and a collaboration list (which agents it
  may spawn). One job per agent ("plan agent turns a spec into a plan,
  nothing else").
- **Least privilege as the organizing principle (04:32–06:03).** Every agent
  runs in its own container; environments define network allowlists (e.g.
  only `api.front.com`), so "even if a prompt leak comes inside of it,
  there's nothing it can do." Customer-support agent never sees GitHub/Gmail.
- **Files behind an MCP, not raw FS (07:01–07:55).** Containers are
  ephemeral, so persistent files live in Cloudflare R2 with an MCP gatekeeper
  doing server-side checks: per-agent folder scoping, write-but-not-delete.
- **Secrets (08:25–09:00).** Env vars injected per session, stored encrypted
  (Google KMS-style); read-only DB credentials as the norm.
- **Tasks and templates (09:14–14:12).** Kanban tasks, run-once / scheduled /
  recurring, startable from **templates** — his "compound engineer" template
  is a chained pipeline: write spec *(human approval gate)* → plan → plan
  review (coordinator fans out 4 reviewers: feasibility, scope guardian,
  coherence…) → revise plan → implement → AI code review → apply fixes →
  **librarian updates internal wiki** → human review & deploy. Marking a task
  done auto-starts the next. A feature goes in at 3pm and is a tested PR by
  9pm.
- **Inbox as the only human channel (14:30–16:10).** An MCP the agents write
  to; supports free-chat replies, **multiple-choice questions** (AskUser-style
  radio options), and push notifications through a mobile-responsive PWA —
  he approves specs from the gym.
- **Triggers, automations (16:46–19:00).** Webhook triggers (customer-support
  message → classify & route, fired 600×; bug report → diagnose → report →
  human approves → full fix pipeline) and cron automations (weekly LinkedIn
  content).
- **Goals = definition-of-done loops (19:08–21:23).** For open-ended work: a
  spec is turned into a checklist of done-criteria; an **orchestrator** loops
  — after each session it re-checks progress logs against the criteria and
  spawns the next specialist — until all boxes tick. Guardrails per goal:
  **spend cap** (he burned $1,000 in one night without one), wall-clock
  limit, stuck-iteration threshold (kill after N identical iterations),
  session budget.
- **Cost tiering (21:26–22:31).** Cloud-managed agents got expensive (~$500/
  day), so goals can pin runtimes: planners on Claude in the cloud, workers
  on a cheap local VM runner ("grok yolo mode"), overflow back to cloud.
- **Everything-as-YAML + CLI (23:20–25:45).** Agents, skills, templates live
  as YAML files in each repo (`.agentos/`); a CLI pushes/pulls/syncs them and
  can create projects/goals from a local Claude chat. Config is versioned
  code, the web UI is a view over it.

## 2. What Atrium already has (don't rebuild)

Per `DESIGN.md`/`PLAN.md` and the shipped prototype: event-log relay with
scoped fan-out, agent drivers + per-channel dispatcher, tiered memory with
review queue/quarantine (stronger than his Knowledge tab), LocalSandbox with
approvals + audit (his approval gates, generalized), routines (his cron
automations, seeded in W5), plan-then-execute data tool.

## 3. What to steal — gap list for Atrium

Ranked; each maps to a widening slice after owner review.

1. **Inbox + AskUser protocol.** A first-class human-attention surface:
   agents post blocking questions (free-text and multiple-choice) and status
   messages; replying resumes the run. This is his single best retention
   mechanic — the human manages an inbox, not sessions. Pairs with PWA push.
2. **Goal loops with hard guardrails.** Definition-of-done checklist +
   orchestrator re-check after every session + **spend cap / wall-clock /
   stuck-threshold** per goal. The guardrail block (frame at 20:55) is a
   ready-made spec: speed cap $, wall-clock hours, stuck iterations, session
   budget minutes, runtime pinning per role (planners→Claude, workers→local).
3. **Pipeline templates with approval gates.** Chained task templates where
   steps carry `agent + prompt + requires-approval`; done-flag cascades. His
   compound-engineer chain is exactly our design→plan→execute doctrine turned
   into a product object.
4. **Environment network allowlists.** Atrium's tenancy seam walls off data;
   his environments wall off *egress* (per-agent domain allowlist). Add to
   the sandbox provider contract (E2B supports this).
5. **Files behind an MCP with server-side policy** (per-agent folder scope,
   write-no-delete) instead of raw mounts — matches our fail-closed bias.
6. **Everything-as-YAML + CLI sync.** Agents/skills/templates as repo-
   versioned YAML mirrored by the web UI; CLI push/pull. This is also
   type.com's "import from Claude Code" wedge (research §8.3) — same feature
   seen from two directions; strong signal it's the right onboarding.
7. **Librarian step** — a wiki/memory-update stage baked into pipelines, so
   the brain compounds per merge (type.com's self-improvement loop, made
   concrete).
8. **Cost visibility + runner tiers.** A Costs page; per-goal runtime
   pinning; cheap-runner pool for workers. His $500/day and $1,000-night are
   the cautionary numbers to design against.

Anti-lessons: he has **no multi-tenancy, no RBAC, no memory quality gates**
— one-person system. Atrium's tenancy seam, quarantine, and review queue are
differentiators to keep, not overhead to shed.

## 4. Design direction — type.com × OpenMausBot cross

Owner likes type.com's look; the app should read as a cross between it and
the OpenMausBot (Grok Bot) app. Both palettes were sampled 2026-08-16
(type.com live site; `src/styles.css` upstream).

**type.com brings (light, warm, editorial):**
- Warm off-white / faint blue-tinted ground (#f4f6fb-ish) with soft gradient
  washes and glassy orb illustrations; generous whitespace.
- Indigo/blue-violet display headlines (~#3b4fd9), near-black body, serif
  logotype; small grotesque body type.
- Deep aubergine/plum primary CTA (near #3a2340), white pill chips with
  hairline borders, soft large-radius cards with faint shadows.
- Product-UI-as-hero: cream/ivory app chrome, pill filter chips, thread
  cards.

**OpenMausBot brings (dark, dense, kinetic):**
- Near-black layered surfaces (#070707 app / #111 panel / #262626 card /
  #333 hairlines), white ink at two opacities.
- Electric blue accent (#1084fe), status greens/reds (#38d591/#ff5667).
- Inter, tight 6–10px radii, and a worked-out motion vocabulary: panel-in,
  pop-in, msg-in (0.18–0.24s, cubic-bezier(0.22,1,0.36,1)), step-blink
  streaming caret, shimmer.

**The cross, as rules for the Atrium web UI:**
1. **Light-first, type.com ground; dark mode inherits OpenMausBot's layer
   stack.** Light: warm off-white ground, ivory raised cards. Dark: #0b0b0d /
   #141416 / #202024 layering (OpenMausBot's scheme, slightly warmed).
2. **One accent family, indigo.** Replace the prototype's teal `--accent`
   with a type.com indigo (~#3b4fd9 light / #7a8cff dark) for interactive
   elements; keep OpenMausBot's green/red semantics for run/fail states.
   Aubergine reserved for the single primary CTA per view.
3. **Typography:** grotesque/Inter UI text; one editorial serif used
   sparingly — page titles and empty states (type.com's voice); `--font-mono`
   stays for protocol labels, event ids, YAML.
4. **Shape:** type.com's soft cards (12–16px radius, hairline border, faint
   shadow) for content surfaces; OpenMausBot's tighter 6–10px radius for
   controls, chips, and terminal-ish panes (sessions, logs).
5. **Motion:** adopt OpenMausBot's animation set wholesale (panel-in, pop-in,
   msg-in, caret-blink) — type.com is static; our liveness (streams,
   dispatch, approvals) should feel like the Grok Bot app.
6. **Chips and gates:** pill chips (type.com) for filters/spaces; rectangular
   status badges (video's Approval / agent tags) for pipeline steps.
7. Keep D11's token discipline (`:root` light, dark redefinitions) — this is
   a palette swap plus a serif and radius layer, not a rework.

Not the model: Danny's own UI (olive-black + yellow) — studied for
information architecture (sidebar taxonomy, guardrail dialog, subtask
checklists), not for its palette.
