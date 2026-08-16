// E7 demo seed: "Acme Digital" — a cohesive company story that populates every
// surface of Atrium (chat, DMs, inbox, questions, approvals, goals, pipelines,
// routines, memory, connectors, files, computer, costs, audit) via the REST
// API against an ALREADY RUNNING relay.
// Usage: corepack pnpm demo        (start the stack first: corepack pnpm start)
//        node scripts/demo-seed.mjs --base http://localhost:PORT
// Idempotent: if an "engineering" channel already exists, seeding is skipped.
//
// Ordering rule (hard-won): a pending ask_user question or unapproved
// sandbox_exec BLOCKS that channel's agent queue. Everything a channel needs
// is seeded before its deliberate open blocker; the demo's two standing
// blockers (#platform pending compute approval, #approvals pending question)
// are the LAST things seeded in their channels.

// Base resolution: --base <url> flag > BASE env > ATRIUM_PORT env > localhost:8900.
const baseArgIdx = process.argv.indexOf("--base");
const PORT = process.env.ATRIUM_PORT ?? "8900";
const BASE = (baseArgIdx !== -1 ? process.argv[baseArgIdx + 1] : process.env.BASE ?? `http://localhost:${PORT}`).replace(/\/$/, "");

async function api(pathName, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathName} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The server must already be running.
  try {
    await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ name: "" }) });
  } catch {
    console.error(`No Atrium relay on ${BASE}.`);
    console.error("Start it first:  cd platform && corepack pnpm start");
    process.exit(1);
  }

  // First human login in a fresh org becomes admin.
  const yosri = await api("/api/login", { method: "POST", body: { name: "Yosri" } });
  const t = yosri.token;
  const state = () => api("/api/state", { token: t });

  // Idempotency: an existing #engineering channel means the demo is seeded.
  const state0 = await state();
  if (state0.channels.some((c) => c.name === "engineering")) {
    console.log('Demo already seeded (found an "engineering" channel) — nothing to do.');
    console.log("Log in as: Yosri (admin), or Sara / Omar / Lina (members).");
    return;
  }

  /** Poll /api/state until pred(state) is truthy (or fail loudly). */
  async function until(label, pred, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await state();
      const hit = pred(s);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await sleep(200);
    }
  }

  /** Post a chat message as some user's token. */
  const say = (token, channelId, text) =>
    api(`/api/channels/${channelId}/messages`, { method: "POST", token, body: { text } });

  /** Post an @mention and wait until the agent's turn fully completes. */
  async function ask(token, channelId, text) {
    await say(token, channelId, text);
    await sleep(150);
    await until(`agent idle in channel after "${text.slice(0, 40)}…"`, (s) => {
      const open = Object.values(s.openTurns ?? {});
      return open.every((turn) => turn.channelId !== channelId) ? true : null;
    });
  }

  console.log(`Seeding "Acme Digital" into ${BASE} …`);

  // ---- People ----
  const sara = await api("/api/login", { method: "POST", body: { name: "Sara" } });
  const omar = await api("/api/login", { method: "POST", body: { name: "Omar" } });
  const lina = await api("/api/login", { method: "POST", body: { name: "Lina" } });

  // ---- Teams ----
  const eng = (await api("/api/teams", { method: "POST", token: t, body: { name: "Engineering" } })).team;
  const mkt = (await api("/api/teams", { method: "POST", token: t, body: { name: "Marketing" } })).team;
  const fin = (await api("/api/teams", { method: "POST", token: t, body: { name: "Finance" } })).team;
  await api(`/api/teams/${eng.id}/members`, { method: "POST", token: t, body: { userId: sara.user.id } });
  await api(`/api/teams/${eng.id}/members`, { method: "POST", token: t, body: { userId: omar.user.id } });
  await api(`/api/teams/${mkt.id}/members`, { method: "POST", token: t, body: { userId: lina.user.id } });
  await api(`/api/teams/${fin.id}/members`, { method: "POST", token: t, body: { userId: sara.user.id } });

  // ---- Channels (spaces: engineering / marketing / finance / general) ----
  const mkChannel = async (name, space, memberUserIds) => {
    const ch = (await api("/api/channels", { method: "POST", token: t, body: { name, space } })).channel;
    for (const uid of memberUserIds) {
      await api(`/api/channels/${ch.id}/members`, { method: "POST", token: t, body: { userId: uid } });
    }
    return ch;
  };
  const chEng = await mkChannel("engineering", "engineering", [sara.user.id, omar.user.id]);
  const chPlat = await mkChannel("platform", "engineering", [sara.user.id, omar.user.id]);
  const chCamp = await mkChannel("campaigns", "marketing", [lina.user.id]);
  const chFin = await mkChannel("finance", "finance", [sara.user.id]);
  const chGen = await mkChannel("general", "general", [sara.user.id, omar.user.id, lina.user.id]);
  const chProd = await mkChannel("product", "general", [sara.user.id, lina.user.id]);
  const chAppr = await mkChannel("approvals", "general", []);

  // ---- Agents (mock driver; personas + configs) ----
  const mkAgent = async (body) => (await api("/api/agents", { method: "POST", token: t, body })).agent;
  const dev = await mkAgent({
    name: "Dev",
    persona: "Senior engineer at Acme Digital: ships small verified changes, writes runbooks, asks before anything irreversible.",
    channelId: chEng.id,
    networkAllowlist: ["api.github.com"],
  });
  const scout = await mkAgent({
    name: "Scout",
    persona: "Researcher: digs up context across the org's knowledge, cites what it finds, proposes memories instead of asserting.",
    channelId: chEng.id,
  });
  const penny = await mkAgent({
    name: "Penny",
    persona: "Finance analyst: answers with numbers from the governed dataset, always shows the query plan.",
    channelId: chFin.id,
    allowTools: ["data_query"],
  });
  const mailer = await mkAgent({
    name: "Mailer",
    persona: "Marketing copywriter: drafts campaign copy in Acme's voice, sentence-case subjects, no exclamation marks.",
    channelId: chCamp.id,
  });
  // Distribute agents across their other rooms.
  const join = (chId, agentId) => api(`/api/channels/${chId}/members`, { method: "POST", token: t, body: { userId: agentId } });
  await join(chPlat.id, dev.id);
  await join(chAppr.id, dev.id);
  await join(chGen.id, scout.id);
  await join(chProd.id, scout.id);
  await join(chGen.id, mailer.id);

  // ---- Connectors (before any recall, so synced memory exists) ----
  const mkConnector = async (body) => (await api("/api/connectors", { method: "POST", token: t, body })).connector;
  const connect = (id) => api(`/api/connectors/${id}`, { method: "POST", token: t, body: { status: "connected" } });
  const sync = (id) => api(`/api/connectors/${id}/sync`, { method: "POST", token: t });
  const sp = await mkConnector({ provider: "sharepoint", kind: "memory", scope: "org" });
  await connect(sp.id);
  await sync(sp.id);
  const conf = await mkConnector({ provider: "confluence", kind: "memory", scope: "team", teamId: eng.id });
  await connect(conf.id);
  await sync(conf.id);
  await mkConnector({ provider: "outlook", kind: "memory", scope: "org" }); // stays disconnected
  const jira = await mkConnector({ provider: "jira", kind: "agent", scope: "org" });
  await connect(jira.id);
  await api(`/api/connectors/${jira.id}`, {
    method: "POST",
    token: t,
    body: { tools: jira.tools.map((tool) => ({ ...tool, enabled: !/^(create_issue|comment)$/.test(tool.name) })) },
  });
  const dbx = await mkConnector({ provider: "databricks", kind: "agent", scope: "org" });
  await connect(dbx.id);
  await mkConnector({ provider: "github", kind: "agent", scope: "org" }); // stays disconnected
  console.log("  connectors: sharepoint+confluence synced, jira (2 tools off) + databricks live, outlook + github dark");

  // ---- #general: welcome talk + Scout's research brief (Files page) ----
  await say(t, chGen.id, "Morning Acme — sprint 34 starts today. Priorities: SSO launch, pricing refresh, Q4 planning.");
  await say(sara.token, chGen.id, "Engineering is heads-down on SSO. Demo Friday if the IdP sandbox behaves.");
  await say(lina.token, chGen.id, "Pricing page copy review is on my desk — new tiers land with the campaign.");
  await say(omar.token, chGen.id, "FYI deploy freeze still applies Fridays after 15:00, per ops.");
  await ask(t, chGen.id, "@Scout save file research-brief.md: Competitor scan for Q3 — pricing moved to per-seat everywhere; SSO is now table stakes; two rivals launched AI assistants.");
  await ask(sara.token, chGen.id, "@Scout remember Lina owns the launch newsletter");
  await ask(lina.token, chGen.id, "@Mailer draft a one-line teaser for the SSO launch, keep it in our voice.");

  // ---- #product: customer signal, Scout recall from synced org memory ----
  await say(t, chProd.id, "Top customer ask this week: bring-your-own-identity. SSO launch can't slip.");
  await say(lina.token, chProd.id, "Support echoed that — 14 tickets mention SAML in July alone.");
  await say(sara.token, chProd.id, "Incident postmortem from last week is in the wiki, severity levels linked.");
  await ask(t, chProd.id, "@Scout recall incident severity");
  await ask(lina.token, chProd.id, "@Scout recall pricing");

  // ---- #engineering: ops talk, egress both ways, remember→accept→recall, files, answered question ----
  await say(t, chEng.id, "SSO week. Sara owns the IdP integration, Omar the session store migration.");
  await say(sara.token, chEng.id, "SAML assertions verified against the sandbox IdP — clock skew was the culprit.");
  await say(omar.token, chEng.id, "Session store cutover rehearsed on staging, rollback script tested.");
  await ask(t, chEng.id, "@Dev fetch https://api.github.com/repos");
  await ask(sara.token, chEng.id, "@Dev fetch https://internal.acme.local/secrets");
  await say(omar.token, chEng.id, "^ good — egress policy held. Only api.github.com is on Dev's allowlist.");
  await ask(sara.token, chEng.id, "@Scout remember the design review happens Thursdays");
  // Accept the proposal so Scout can recall it (search only returns confirmed+ tiers).
  const thursdays = await until("design-review proposal in review queue", (s) =>
    s.memory.find((m) => m.trustTier === "agent_proposed" && /design review happens Thursdays/i.test(m.content)),
  );
  await api(`/api/memory/${thursdays.id}/review`, { method: "POST", token: t, body: { accept: true } });
  await ask(omar.token, chEng.id, "@Scout recall design review");
  await ask(t, chEng.id, "@Dev save file deploy-checklist.md: 1. freeze announcements 2. run migration dry-run 3. cut release 4. verify SSO round-trip 5. unfreeze");
  // A question Dev asks and Yosri answers (Inbox history).
  await say(t, chEng.id, "@Dev ask me which option for the session-store rollout");
  const q1 = await until("Dev's rollout question pending", (s) => s.questions.find((q) => q.agentId === dev.id && q.status === "pending"));
  await api(`/api/questions/${q1.id}/answer`, { method: "POST", token: t, body: { answer: "Option A" } });
  await until("Dev's rollout question answered + idle", (s) =>
    s.questions.some((q) => q.id === q1.id && q.status === "answered") &&
    Object.values(s.openTurns ?? {}).every((turn) => turn.channelId !== chEng.id),
  );

  // ---- Goals (engines drive them through the same channels) ----
  const mkGoal = (body) => api("/api/goals", { method: "POST", token: t, body });
  await mkGoal({
    name: "Ship SSO onboarding",
    spec: "SAML + OIDC login live behind a feature flag, with a migration path for existing sessions.",
    criteria: ["Integrate the sandbox IdP", "Migrate the session store", "Verify the SSO round-trip on staging"],
    agentId: dev.id,
    channelId: chEng.id,
  });
  await until('goal "Ship SSO onboarding" done', (s) => s.goals.some((g) => g.name === "Ship SSO onboarding" && g.status === "done"));
  await mkGoal({
    name: "Migrate legacy CRM",
    spec: "Move accounts off the unsupported CRM. Blocked upstream: the vendor export API was sunset.",
    criteria: ["impossible: export all records via the sunset vendor API tonight"],
    agentId: scout.id,
    channelId: chEng.id,
  });
  await until('goal "Migrate legacy CRM" halted (stuck guardrail)', (s) => s.goals.some((g) => g.name === "Migrate legacy CRM" && g.status === "halted"));

  // ---- Pipelines: "Compound feature" run twice (one done, one parked) ----
  const compound = (
    await api("/api/templates", {
      method: "POST",
      token: t,
      body: {
        name: "Compound feature",
        steps: [
          { title: "Write spec", agentId: scout.id, prompt: "Write the one-page spec.", requiresApproval: true },
          { title: "Implement", agentId: dev.id, prompt: "Implement the approved spec." },
          { title: "Update wiki", agentId: scout.id, prompt: "Record the change in the wiki." },
        ],
      },
    })
  ).template;
  const run1 = (await api("/api/pipelines", { method: "POST", token: t, body: { templateId: compound.id, channelId: chEng.id, name: "Compound feature — audit log export", input: "audit log export for admins" } })).run;
  await until("run1 at the spec gate", (s) => s.pipelines.some((p) => p.id === run1.id && p.stepStates.includes("awaiting_approval")));
  await api(`/api/pipelines/${run1.id}/advance`, { method: "POST", token: t });
  await until("run1 completed", (s) => s.pipelines.some((p) => p.id === run1.id && p.status === "done"));
  const run2 = (await api("/api/pipelines", { method: "POST", token: t, body: { templateId: compound.id, channelId: chEng.id, name: "Compound feature — SCIM provisioning", input: "SCIM user provisioning" } })).run;
  await until("run2 parked at the spec gate", (s) => s.pipelines.some((p) => p.id === run2.id && p.stepStates.includes("awaiting_approval")));

  // ---- Routines ----
  const digest = (
    await api("/api/routines", {
      method: "POST",
      token: t,
      body: { name: "Weekly digest", agentId: scout.id, channelId: chGen.id, prompt: "post a weekly digest of what shipped across Acme Digital", schedule: { kind: "interval", minutes: 10080 } },
    })
  ).routine;
  const standup = (
    await api("/api/routines", {
      method: "POST",
      token: t,
      body: { name: "Daily standup summary", agentId: dev.id, channelId: chEng.id, prompt: "summarize today's standup notes for the channel", schedule: { kind: "manual" } },
    })
  ).routine;
  await api(`/api/routines/${standup.id}/run`, { method: "POST", token: t });
  await sleep(200);
  await until("standup routine turn finished", (s) => Object.values(s.openTurns ?? {}).every((turn) => turn.channelId !== chEng.id));

  // ---- #campaigns: quarantined memory, campaign goal, gated pipeline, open inbox item ----
  await say(lina.token, chCamp.id, "Pricing refresh campaign: landing page + email drip + the launch newsletter.");
  await say(t, chCamp.id, "Budget approved. Draft goes through the gate before anything is scheduled.");
  await ask(lina.token, chCamp.id, "@Mailer remember always use sentence case in email subject lines");
  await ask(lina.token, chCamp.id, "@Mailer give me three subject line options for the pricing refresh drip.");
  await mkGoal({
    name: "Refresh pricing page",
    spec: "New three-tier pricing live with updated copy and screenshots.",
    criteria: ["Rewrite the tier copy", "Swap in the new screenshots"],
    agentId: mailer.id,
    channelId: chCamp.id,
  });
  await until('goal "Refresh pricing page" done', (s) => s.goals.some((g) => g.name === "Refresh pricing page" && g.status === "done"));
  const launch = (
    await api("/api/templates", {
      method: "POST",
      token: t,
      body: {
        name: "Campaign launch",
        steps: [
          { title: "Draft copy", agentId: mailer.id, prompt: "Draft the campaign copy.", requiresApproval: true },
          { title: "Schedule sends", agentId: mailer.id, prompt: "Schedule the approved sends." },
        ],
      },
    })
  ).template;
  const campRun = (await api("/api/pipelines", { method: "POST", token: t, body: { templateId: launch.id, channelId: chCamp.id, name: "Campaign launch — pricing refresh", input: "pricing refresh drip" } })).run;
  await until("campaign run parked at the draft gate", (s) => s.pipelines.some((p) => p.id === campRun.id && p.stepStates.includes("awaiting_approval")));
  await ask(t, chCamp.id, "@Mailer notify me when the campaign draft is ready"); // OPEN inbox item

  // ---- #finance: Penny's plan card + a second answered question + planning goal ----
  await say(t, chFin.id, "Board pack due next week — I need the revenue picture and the Q4 plan skeleton.");
  await say(sara.token, chFin.id, "Databricks gold tables refreshed this morning, numbers are current.");
  await ask(t, chFin.id, "@Penny what are the Q3 revenue numbers"); // plan-then-execute card
  await say(sara.token, chFin.id, "@Penny ask me which option for the forecast basis");
  const q2 = await until("Penny's forecast question pending", (s) => s.questions.find((q) => q.agentId === penny.id && q.status === "pending"));
  await api(`/api/questions/${q2.id}/answer`, { method: "POST", token: sara.token, body: { answer: "Option B" } });
  await until("Penny's question answered + idle", (s) =>
    s.questions.some((q) => q.id === q2.id && q.status === "answered") &&
    Object.values(s.openTurns ?? {}).every((turn) => turn.channelId !== chFin.id),
  );
  await mkGoal({
    name: "Q4 planning docs",
    spec: "Planning skeleton for Q4: headcount, spend envelope, initiative one-pagers.",
    criteria: ["Collect the team inputs", "Publish the planning skeleton"],
    agentId: penny.id,
    channelId: chFin.id,
  });
  await until('goal "Q4 planning docs" done', (s) => s.goals.some((g) => g.name === "Q4 planning docs" && g.status === "done"));

  // ---- DMs with Dev and Scout ----
  const dmDev = (await api("/api/dm", { method: "POST", token: t, body: { agentId: dev.id } })).channel;
  await ask(t, dmDev.id, "quick status on the SSO branch?");
  await ask(t, dmDev.id, "save file sso-rollout-notes.md: flag at 10% Monday, 50% Wednesday, GA Friday if error budget holds");
  const dmScout = (await api("/api/dm", { method: "POST", token: t, body: { agentId: scout.id } })).channel;
  await ask(t, dmScout.id, "recall company handbook");
  await ask(t, dmScout.id, "thanks — pull the pricing sheet into the board pack tomorrow");

  // ---- #platform: remember, approved compute (Computer page), then the PENDING compute ----
  await say(omar.token, chPlat.id, "Build farm p95 crept up 12% this week — suspecting the new lint stage.");
  await say(sara.token, chPlat.id, "Staging deploy window moved to 14:00 so it clears before the Friday freeze.");
  await ask(sara.token, chPlat.id, "@Dev remember staging deploys go out at 14:00 daily");
  await say(t, chPlat.id, "@Dev compute the build farm throughput"); // -> sandbox approval (Dev lacks sandbox_exec)
  const appr1 = await until("first compute awaiting approval", (s) => s.approvals.find((a) => a.agentId === dev.id && a.status === "pending"));
  await api(`/api/approvals/${appr1.id}`, { method: "POST", token: t, body: { approve: true } });
  await until("approved compute finished (Computer page entry)", (s) =>
    Object.values(s.openTurns ?? {}).every((turn) => turn.channelId !== chPlat.id),
  );
  // Deliberately LEFT PENDING — the demo's live approval card. Nothing else in #platform after this.
  await say(omar.token, chPlat.id, "@Dev compute the projected cost of the CRM migration");
  await until("second compute parked as a pending approval", (s) => s.approvals.some((a) => a.agentId === dev.id && a.status === "pending"));

  // ---- Memory review: accept some agent proposals, leave 2 pending + 1 quarantined ----
  const s1 = await state();
  const staging = s1.memory.find((m) => m.trustTier === "agent_proposed" && /staging deploys go out/i.test(m.content));
  const newsletter = s1.memory.find((m) => m.trustTier === "agent_proposed" && /owns the launch newsletter/i.test(m.content));
  const lessons = s1.memory.filter((m) => m.trustTier === "agent_proposed" && m.kind === "lesson");
  for (const entry of [staging, newsletter, lessons[0]].filter(Boolean)) {
    await api(`/api/memory/${entry.id}/review`, { method: "POST", token: t, body: { accept: true } });
  }

  // ---- LAST: the standing pending question, in its own #approvals channel ----
  await say(t, chAppr.id, "@Dev which option should we take for the GA rollout?");
  await until("standing question pending in #approvals", (s) => s.questions.some((q) => q.channelId === chAppr.id && q.status === "pending"));

  // ---- Story summary ----
  const s = await state();
  const pendingMem = s.memory.filter((m) => m.trustTier === "agent_proposed").length;
  const quarantined = s.memory.filter((m) => m.trustTier === "quarantined").length;
  console.log("\nSeeded Acme Digital — sprint 34, SSO launch week:\n");
  console.log("  people:     Yosri (admin) + Sara, Omar, Lina; teams Engineering (Sara, Omar), Marketing (Lina), Finance (Sara)");
  console.log("  agents:     Dev (engineer, github-only egress), Scout (researcher), Penny (finance, plan cards), Mailer (copywriter)");
  console.log(`  channels:   ${s.channels.filter((c) => c.space !== "dm").length} rooms across 4 spaces + DMs with Dev and Scout`);
  console.log(`  goals:      ${s.goals.map((g) => `"${g.name}" [${g.status}]`).join(", ")}`);
  console.log(`  pipelines:  ${s.pipelines.map((p) => `"${p.name}" [${p.stepStates.includes("awaiting_approval") ? "gated" : p.status}]`).join(", ")}`);
  console.log("  routines:   Weekly digest (Scout, weekly) + Daily standup summary (Dev, manual, ran once)");
  console.log(`  memory:     ${s.memory.length} entries (synced + accepted lessons; ${pendingMem} pending review, ${quarantined} quarantined)`);
  console.log(`  inbox:      ${s.inbox.filter((i) => i.status === "open").length} open item (Mailer), questions: ${s.questions.filter((q) => q.status === "pending").length} pending / ${s.questions.filter((q) => q.status === "answered").length} answered`);
  console.log(`  approvals:  ${s.approvals.filter((a) => a.status === "pending").length} pending compute in #platform (plus one approved run on the Computer page)`);
  console.log("  connectors: sharepoint + confluence synced; jira (create_issue/comment off) + databricks connected; outlook + github disconnected");
  console.log(`\nOpen ${BASE} and log in as: Yosri (admin) — or Sara, Omar, Lina to see member views.`);
  console.log("Things to try: answer the #approvals question, approve the #platform compute, advance the gated pipelines, review pending memory.");
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
