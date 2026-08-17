// P12 demo seed: "Acme Digital" — a cohesive story painted across every ported
// surface of the upstream app (inbox, questions, goals, pipelines, board,
// memory, org connectors, files, admin/audit) via the REST API against an
// ALREADY RUNNING server.
//
// Usage:  corepack pnpm demo:org                     (dev server on 8799)
//         node scripts/demo-seed.mjs --base http://localhost:PORT
//         node scripts/demo-seed.mjs --base … --instance acme-mock --model claude-opus-5
//
// SAFETY: seeded bots get modelSelection {instanceId:"", model:""} unless an
// explicit --instance is passed, so seeding can NEVER spawn a real provider
// session (goal/pipeline turns simply fail to dispatch). The e2e walkthrough
// passes --instance pointing at a mock Anthropic endpoint, which lets goals
// genuinely run to done/paused and the cost ledger fill with computed spend.
// Without --instance, the done/paused goals are skipped (their states are
// unreachable without a driver) and the halted goal halts on the stuck
// guardrail after failed dispatch attempts — documented in the summary.
//
// Costs have no write API (the ledger is a bus tee over real turns): with a
// mock instance they fill organically; without one, seeding costs would need
// a server-stopped costs.json write, so it is skipped live.
//
// Idempotent: a bot named "Acme Dev" means the story is already seeded.

const argv = process.argv;
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const BASE = (flag("base") ?? process.env.BASE ?? "http://localhost:8799").replace(/\/$/, "");
const INSTANCE = flag("instance") ?? "";
const MODEL = flag("model") ?? "";

async function api(pathName, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathName} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until pred() returns truthy (or fail loudly). */
async function until(label, pred, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await pred();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(300);
  }
}

async function main() {
  try {
    await api("/api/health");
  } catch {
    console.error(`No OpenMausBot server on ${BASE}. Start it first: corepack pnpm dev:server`);
    process.exit(1);
  }

  // Idempotency: an "Acme Dev" bot means the story is already painted.
  const existing = await api("/api/bots");
  if (existing.bots.some((b) => b.name === "Acme Dev")) {
    console.log('Demo already seeded (found bot "Acme Dev") — nothing to do.');
    return;
  }

  console.log(`Seeding "Acme Digital" into ${BASE}${INSTANCE ? ` (instance ${INSTANCE})` : " (no driver — safe mode)"} …`);

  // ---- Bots (driver pinned: explicit mock instance, or none at all) ----
  const selection = { instanceId: INSTANCE, model: MODEL };
  const mkBot = async (patch) => {
    const { bot } = await api("/api/bots", { method: "POST" });
    const updated = await api(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: { ...patch, modelSelection: selection },
    });
    return updated.bot;
  };
  const dev = await mkBot({
    name: "Acme Dev",
    title: "Senior engineer",
    description: "Ships small verified changes, writes runbooks, asks before anything irreversible.",
    color: "blue",
  });
  const scout = await mkBot({
    name: "Acme Scout",
    title: "Researcher",
    description: "Digs up context across the org's knowledge and proposes memories instead of asserting.",
    color: "green",
  });
  const penny = await mkBot({
    name: "Acme Penny",
    title: "Finance analyst",
    description: "Answers with numbers from the governed dataset and always shows the working.",
    color: "pink",
  });
  console.log("  bots:       Acme Dev, Acme Scout, Acme Penny");

  // ---- Org connectors: 4 providers across both kinds ----
  const mkConn = async (body) => (await api("/api/org-connectors", { method: "POST", body })).connector;
  const sp = await mkConn({ provider: "sharepoint", kind: "memory" });
  await api(`/api/org-connectors/${sp.id}/connect`, { method: "POST" });
  await api(`/api/org-connectors/${sp.id}/sync`, { method: "POST" });
  const conf = await mkConn({ provider: "confluence", kind: "memory" });
  await api(`/api/org-connectors/${conf.id}/connect`, { method: "POST" });
  await api(`/api/org-connectors/${conf.id}/sync`, { method: "POST" });
  const jira = await mkConn({ provider: "jira", kind: "agent", accessLevel: "write_no_delete" });
  await api(`/api/org-connectors/${jira.id}/connect`, { method: "POST" });
  await api(`/api/org-connectors/${jira.id}/tools`, {
    method: "POST",
    body: { name: jira.tools[0].name, enabled: false },
  });
  await mkConn({ provider: "github", kind: "agent" }); // stays disconnected
  console.log("  connectors: sharepoint + confluence synced, jira live (1 tool off), github dark");

  // ---- Memory: kinds, tiers, sources, supersede chain, review queue ----
  const addMem = async (body) => (await api("/api/memory", { method: "POST", body })).entry;
  const propose = async (body) => (await api("/api/memory/propose", { method: "POST", body })).entry;
  const freeze = await addMem({
    kind: "procedure",
    content: "Deploy freeze applies Fridays after 15:00 — no production releases past that point.",
  });
  await addMem({
    kind: "procedure",
    content: "Deploy freeze applies Fridays after 14:00 (moved an hour earlier for the EU region).",
    supersedes: freeze.id, // supersede chain: 15:00 entry struck through
  });
  const handbook = await addMem({
    kind: "glossary",
    content: '"Gold tables" = the curated Databricks datasets finance reports are built from.',
  });
  await api(`/api/memory/${handbook.id}/promote`, { method: "POST" }); // -> org_ratified
  await addMem({ kind: "fact", content: "Sprint 34 priorities: SSO launch, pricing refresh, Q4 planning." });
  // Review queue: a plain agent proposal + a link-bearing one that quarantines.
  await propose({
    kind: "lesson",
    content: "SAML clock skew was the root cause of the sandbox IdP failures — check NTP first.",
    author: dev.id,
  });
  await propose({
    kind: "fact",
    content: "Vendor status page https://status.vendor.example says the export API sunsets in Q4.",
    author: scout.id,
  });
  console.log("  memory:     6 entries — supersede chain, ratified glossary, 2 in the review queue");

  // ---- Files: 2 uploads ----
  const upload = (name, text, mime) =>
    api("/api/org-files", {
      method: "POST",
      body: { name, mime, dataBase64: Buffer.from(text).toString("base64") },
    });
  await upload(
    "release-checklist.md",
    "# Release checklist\n1. freeze announcements\n2. migration dry-run\n3. cut release\n4. verify SSO round-trip\n5. unfreeze\n",
    "text/markdown",
  );
  await upload(
    "q3-competitor-scan.md",
    "# Q3 competitor scan\n- pricing moved to per-seat everywhere\n- SSO is table stakes\n- two rivals launched AI assistants\n",
    "text/markdown",
  );
  console.log("  files:      release-checklist.md, q3-competitor-scan.md");

  // ---- Inbox: 2 items + 1 answered + 1 PENDING question ----
  await api("/api/inbox", {
    method: "POST",
    body: { botId: scout.id, text: "Competitor scan is filed — two rivals shipped AI assistants this quarter." },
  });
  await api("/api/inbox", {
    method: "POST",
    body: { botId: penny.id, text: "Q3 revenue numbers are ready for the board pack review." },
  });
  const answered = (
    await api("/api/inbox/questions", {
      method: "POST",
      body: { botId: penny.id, prompt: "Which forecast basis for the Q4 plan?", options: ["Conservative", "Momentum"] },
    })
  ).question;
  await api(`/api/inbox/questions/${answered.id}/answer`, { method: "POST", body: { answer: "Conservative" } });
  await api("/api/inbox/questions", {
    method: "POST",
    body: {
      botId: dev.id,
      prompt: "Which rollout option for the session-store migration?",
      options: ["Option A — flag at 10%", "Option B — big bang"],
    },
  });
  console.log("  inbox:      2 items, 1 answered question, 1 pending question");

  // ---- Goals across states ----
  const mkGoal = async (body) => (await api("/api/goals", { method: "POST", body })).goal;
  const goalById = async (id) => (await api("/api/goals")).goals.find((g) => g.id === id);

  // Halted: the criterion is unreachable; the stuck guardrail halts the loop.
  // With a mock instance the sessions really run (and cost real ledger cents);
  // without one every dispatch fails and stuck climbs the same way.
  const crm = await mkGoal({
    name: "Migrate legacy CRM",
    botId: scout.id,
    criteria: ["impossible: export all records via the sunset vendor API tonight"],
    guardrails: { maxSessions: 6, stuckThreshold: 2, spendCapUsd: 2, wallClockMinutes: 30 },
  });
  await until('goal "Migrate legacy CRM" halted', async () => (await goalById(crm.id))?.status === "halted");

  if (INSTANCE) {
    // Done: the mock replies DONE per criterion.
    const sso = await mkGoal({
      name: "Ship SSO onboarding",
      botId: dev.id,
      criteria: ["Integrate the sandbox IdP", "Verify the SSO round-trip on staging"],
    });
    await until('goal "Ship SSO onboarding" done', async () => (await goalById(sso.id))?.status === "done");
    // Paused: the mock never says DONE for "keep iterating" work; pause after
    // the first session lands so the guardrail meters show real usage.
    const q4 = await mkGoal({
      name: "Q4 planning docs",
      botId: penny.id,
      criteria: ["keep iterating on the planning skeleton until review"],
    });
    await until('goal "Q4 planning docs" has a session', async () => ((await goalById(q4.id))?.sessions ?? 0) >= 1);
    await until('goal "Q4 planning docs" paused', async () => {
      const g = await goalById(q4.id);
      if (!g || g.status !== "running") return g?.status === "paused";
      const paused = await api(`/api/goals/${q4.id}/pause`, { method: "POST" }).catch(() => null);
      return paused?.goal?.status === "paused";
    });
    // Cancelled (board's Halted column).
    const legacy = await mkGoal({
      name: "Sunset legacy dashboards",
      botId: scout.id,
      criteria: ["keep iterating on the dashboard inventory"],
    });
    await api(`/api/goals/${legacy.id}/cancel`, { method: "POST" });
    console.log("  goals:      done / paused / halted / cancelled");
  } else {
    console.log("  goals:      halted only (done/paused need a driver — rerun with --instance, see e2e:org)");
  }

  // ---- Pipeline: template + a run suspended at its (first, gated) step ----
  const template = (
    await api("/api/templates", {
      method: "POST",
      body: {
        name: "Release notes",
        steps: [
          { title: "Draft the notes", prompt: "Draft the release notes for sprint 34.", botId: scout.id, gate: "approval" },
          { title: "Publish summary", prompt: "Publish the approved notes to the changelog.", botId: dev.id },
        ],
      },
    })
  ).template;
  const run = (
    await api("/api/pipelines", { method: "POST", body: { templateId: template.id, input: "sprint 34" } })
  ).run;
  await until("release-notes run suspended at the gate", async () => {
    const { runs } = await api("/api/pipelines");
    return runs.find((r) => r.id === run.id)?.status === "waiting_approval";
  });
  console.log('  pipeline:   "Release notes" run waiting at the Draft gate (approve it from Pipelines or Inbox)');

  if (!INSTANCE) {
    console.log("  costs:      skipped — the ledger records real turns only; a live write would need the server stopped");
  }

  console.log(`\nSeeded. Open ${BASE} — things to try: answer the pending Inbox question, approve the gated`);
  console.log("pipeline run, accept the Memory review queue, check the Board columns and the audit chain in Admin.");
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
