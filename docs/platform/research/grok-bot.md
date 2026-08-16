# Expert Briefing: xAI's Grok Bot (August 2026)

*Compiled 2026-08-16. x.ai / docs.x.ai and most press domains were egress-blocked from the research environment; assembled from search-index snippets of the official docs (docs.x.ai/grok-bot/*), the launch announcement, press coverage, third-party reviews, and HN reaction.*

---

## 1. Product concept and UX metaphor

Grok Bot, launched in **early beta on August 11, 2026**, is xAI's agent product: a **team of always-on AI "Bots"** that "sign in to your tools, use them just like you do, and come back with finished work" (tagline: *"A new kind of colleague"*). The core UX metaphor is a **messaging app, not a chat assistant**: a **roster of named agents you message like colleagues** — DMs, group chats, proactive messages back when work finishes or approval is needed.

Key conceptual moves:
- **Bots as durable teammates**, not sessions: persistent identity, memory of prior work, own conversations, skills, routines.
- **Persistence independent of your devices**: Bots run on a cloud computer, keep working with laptop and phone off.
- **Work by demonstration**: a Bot can learn a workflow from a single human demonstration.
- Distinct from Grok on grok.com — separate app and docs tree.

## 2. Full feature inventory

**Bot creation & personas** — "Create new agent" → conversational onboarding (describe the job; it asks which tools/data it needs); Edit Profile sets name, title, description, avatar. **Limit: 50 Bots + group chats per account.** Common roles: inbox manager, research bot, writing assistant, CRM keeper, support agent.

**Models** — Runs on **Grok 4.6** (500K context, image input, configurable reasoning low→xhigh, function calling, web/X search, code execution, prompt caching, context compaction). Billing "follows the model and tokens used by the managed router" — no published per-model choice for users.

**The cloud computer** (`/grok-bot/computer-and-apps`)
- A **persistent cloud computer per user account** (not per Bot) with browser, terminal, filesystem.
- **Each Bot gets its own screen** on the shared computer → parallel computer-use tasks. Docs are explicit: screens are **"separate work surfaces, not separate security boundaries."**
- Shared workspace at **`/workspace`**.
- Bots operate apps by **screenshots + mouse/keyboard** ("any app, no API"), not just connectors.

**App connections & logins**
- **~220 plugins** at launch: Google Workspace, Slack, Microsoft 365, Salesforce, Notion, Glean, GitHub, Jira, AWS Agents/SageMaker, Browserbase, Composio, Context7, custom plugins. Plugin connections **shared across the whole Bot fleet**.
- Non-integrated apps: the Bot navigates to the login screen and requests **human "takeover"** — you enter password/2FA/CAPTCHA, hand back, Bot resumes with a **persistent authenticated session**.
- Sensitive actions pause for **approvals**; live screen watch and takeover any time.

**Skills, routines, scheduling, proactivity**
- **Skill** = reusable task instructions; **routine** = a schedule (hourly/daily/weekly/custom) or event trigger (e.g., new Slack message). Test a skill on a real task, then promote to a routine.
- **50 routines per Bot; 20 run records kept per routine.** Routines execute with all devices off.
- Bots become **proactive over time**, surfacing work before being asked.

**Group chats & multi-bot** — Bots message each other, share context in threads, coordinate in group chats, pass work and ownership, "only pull you in for judgment calls."

**Files** — shared `/workspace`; ~150 MB/file upload per the wider Grok docs.

**Surfaces** — Desktop (macOS/Windows/Linux) + **iOS** (start work, approve, review; same Bots/routines/computer). Android "coming soon." Also "Grok Bot on X" (@bot).

## 3. Architecture (as publicly documented)

- One **VM/cloud computer per account**; per-Bot virtual screens; shared filesystem, shared browser profiles/sessions, shared CLI credentials.
- **Computer-use-first** (screenshots + input events) with a ~220-plugin connector layer.
- Managed **model router** over Grok 4.6-class models; token-metered.
- Approvals engine; live screen view + takeover; **audit view "coming."**

## 4. Pricing & positioning

- **No standalone SKU, no free tier.** Bundled: **SuperGrok Heavy $300/mo**, **Cursor Ultra $200/mo**, **Cursor Teams Premium $120/seat/mo**; 7-day trial. **Enterprise: waitlist only.**
- On top: an **uncapped usage meter** billed by model/tokens through the router; no published price per Bot, per computer-hour, per routine — a repeated criticism.
- Positioning: prosumer/power-user first (Cursor bundling targets developers), stated enterprise ambitions.

## 5. Reception

**Praise:** price-to-performance; Cursor's CEO calls it a daily driver; near-zero onboarding; genuine cross-app work without APIs; real-time X/web integration; demos like 74 game assets in 2 hours. Cited uses: vendor negotiation in the user's voice, store support, continuous CRM upkeep, invoice processing, bug repro + ticket filing.

**Complaints:** beta roughness (audit view "coming"; a test run performs *real* work; approvals don't reverse completed actions); opaque metered billing; expensive gated access; trust overhang from Grok moderation incidents; weaker coding vs rivals in some reviews.

## 6. Security criticisms (the big one)

- **All Bots share one cloud computer** — files, browser sessions, CLI credentials available to the entire roster. Docs: **"do not use separate Bots as a security boundary."** The email Bot's authenticated financial-system session is usable by the CRM Bot.
- **No per-Bot credential assignment, per-site scopes, or privilege-escalation re-approval.**
- **Persistent logins** = long-lived captured-session risk beyond any single task.
- **No SOC 2, ISO 27001, GDPR, or HIPAA claims anywhere** in the docs.
- **Accountability sink** (HN): Bots act under *human* credentials, so every action logs as the human.
- Analyst framing: signing into SaaS with human credentials "ends the integration moat" — and bypasses every SaaS vendor's audit/permission model.

## 7. What a competitor must match — and can beat

**Must match (table stakes):**
1. Messaging-app UX: named bots as contacts, DMs, group chats, bot-to-bot messaging/handoff.
2. Persistent cloud execution with browser + terminal + files; parallel per-bot screens; live screen view + human takeover for logins/2FA/CAPTCHA.
3. Skills → routines: schedules, event triggers, run history, proactivity.
4. Rich connector catalog + computer-use fallback; learn-from-demonstration.
5. Mobile companion (approvals + kickoff) and desktop parity.

**Where Grok Bot is beatable (structural weaknesses):**
1. **Per-bot isolation** — dedicated VM/container/browser profile per bot, credentials scoped per bot and per site, so bots *are* a security boundary.
2. **Service identities** — bots as auditable non-human identities instead of hijacking human credentials; per-bot audit logs now, not "coming."
3. **Enterprise controls** — admin permissioning, spend caps, scoped memories, channel/data policies, SSO/SCIM; real compliance posture.
4. **Self-hosting / BYO-model** — on-prem or on existing Claude/Codex/Grok subscriptions, with per-bot model choice vs an opaque single-vendor router.
5. **Transparent, capped pricing** — vs $120–$300/mo bundles + uncapped meter + waitlisted enterprise.
6. **Reversibility & safety** — dry-run modes that don't perform real work, approval-before-effect, rollback where possible.
7. **Neutral trust posture** — no consumer-brand moderation baggage.

## Sources

Official: x.ai/bot · x.ai/news/introducing-grok-bot · docs.x.ai/grok-bot/{overview,bots,computer-and-apps,skills-routines-and-automations,approvals-security-and-privacy,get-started,faq,mobile} · x.ai/news/grok-4-6 · @bot launch thread.
Press: VentureBeat · TechTimes (shared-VM security) · Unite.AI · Reworked · BusinessToday · Latent.Space AINews · Clarity (credentials/integration moat).
Reviews: eesel (review, pricing) · BuildFastWithAI · DataCamp · MindStudio · DigitalApplied · kingy.ai · explainx · OpenAlternative · AlternativeTo · Memeburn.
