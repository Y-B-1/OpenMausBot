// E7 demo seed: rich walkthrough data via the REST API against an ALREADY
// RUNNING relay (default http://localhost:8900, override with ATRIUM_PORT).
// Usage: corepack pnpm demo   (start the stack first: corepack pnpm start)
// Idempotent: if a "product" channel already exists, seeding is skipped.

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

async function main() {
  // (a) The server must already be running.
  try {
    await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ name: "" }) });
  } catch {
    console.error(`No Atrium relay on ${BASE}.`);
    console.error("Start it first:  cd platform && corepack pnpm start");
    process.exit(1);
  }

  // Admin login (first human in a fresh org becomes admin).
  const yosri = await api("/api/login", { method: "POST", body: { name: "Yosri" } });
  const t = yosri.token;

  // Idempotency: an existing #product channel means the demo is already seeded.
  const state0 = await api("/api/state", { token: t });
  if (state0.channels.some((c) => c.name === "product")) {
    console.log('Demo already seeded (found a "product" channel) — nothing to do.');
    console.log("Log in as: Yosri (admin) or Sara (member).");
    return;
  }

  // People + teams.
  const sara = await api("/api/login", { method: "POST", body: { name: "Sara" } });
  const eng = (await api("/api/teams", { method: "POST", token: t, body: { name: "Engineering" } })).team;
  const fin = (await api("/api/teams", { method: "POST", token: t, body: { name: "Finance" } })).team;
  await api(`/api/teams/${eng.id}/members`, { method: "POST", token: t, body: { userId: sara.user.id } });

  // Channel + agents.
  const product = (await api("/api/channels", { method: "POST", token: t, body: { name: "product", space: "general" } })).channel;
  await api(`/api/channels/${product.id}/members`, { method: "POST", token: t, body: { userId: sara.user.id } });
  const dev = (
    await api("/api/agents", {
      method: "POST",
      token: t,
      body: {
        name: "Dev",
        persona: "Engineer: ships small, verified changes.",
        channelId: product.id,
        networkAllowlist: ["docs.example.com"],
      },
    })
  ).agent;
  const scout = (
    await api("/api/agents", {
      method: "POST",
      token: t,
      body: {
        name: "Scout",
        persona: "Researcher: digs up context, cites what it finds.",
        channelId: product.id,
        networkAllowlist: ["api.github.com", "docs.example.com"],
      },
    })
  ).agent;

  // Group chat kickoff. (The blocking @Dev question is posted LAST — a
  // pending ask_user serializes the channel's agent queue and would stall
  // the goal/pipeline turns below.)
  await api(`/api/channels/${product.id}/messages`, { method: "POST", token: t, body: { text: "Kickoff: shipping the onboarding revamp this sprint." } });

  // DM with Dev.
  await api("/api/dm", { method: "POST", token: t, body: { agentId: dev.id } });

  // Connectors: org memory (SharePoint), team memory (Confluence -> Engineering),
  // agent connector (Jira), and a disconnected Outlook.
  const sp = (await api("/api/connectors", { method: "POST", token: t, body: { provider: "sharepoint", kind: "memory", scope: "org" } })).connector;
  await api(`/api/connectors/${sp.id}`, { method: "POST", token: t, body: { status: "connected" } });
  await api(`/api/connectors/${sp.id}/sync`, { method: "POST", token: t });
  const conf = (await api("/api/connectors", { method: "POST", token: t, body: { provider: "confluence", kind: "memory", scope: "team", teamId: eng.id } })).connector;
  await api(`/api/connectors/${conf.id}`, { method: "POST", token: t, body: { status: "connected" } });
  await api(`/api/connectors/${conf.id}/sync`, { method: "POST", token: t });
  await api("/api/connectors", { method: "POST", token: t, body: { provider: "jira", kind: "agent", scope: "org" } });
  await api("/api/connectors", { method: "POST", token: t, body: { provider: "outlook", kind: "memory", scope: "org" } }); // stays disconnected

  // Goals: one that completes, one that gets stuck on its guardrail.
  await api("/api/goals", {
    method: "POST",
    token: t,
    body: {
      name: "Ship onboarding revamp",
      spec: "New signup flow live behind a flag.",
      criteria: ["Write the code", "Ship the release"],
      agentId: dev.id,
      channelId: product.id,
    },
  });
  await api("/api/goals", {
    method: "POST",
    token: t,
    body: {
      name: "Impossible migration",
      spec: "A goal the agent cannot satisfy — demonstrates the stuck guardrail.",
      criteria: ["impossible: migrate the legacy mainframe tonight"],
      agentId: scout.id,
      channelId: product.id,
    },
  });

  // Pipeline with an approval gate, left awaiting the human.
  const template = (
    await api("/api/templates", {
      method: "POST",
      token: t,
      body: {
        name: "Shipflow",
        steps: [
          { title: "Write spec", agentId: scout.id, prompt: "Produce the spec.", requiresApproval: true },
          { title: "Implement", agentId: dev.id, prompt: "Implement the spec." },
        ],
      },
    })
  ).template;
  await api("/api/pipelines", { method: "POST", token: t, body: { templateId: template.id, channelId: product.id, input: "the demo feature" } });

  // Let the engines settle (mock turns are fast; poll briefly).
  for (let i = 0; i < 30; i++) {
    const s = await api("/api/state", { token: t });
    const done = s.goals.some((g) => g.status === "done");
    const stuck = s.goals.some((g) => g.status !== "done" && g.status !== "running");
    const gated = s.pipelines.some((p) => p.stepStates.includes("awaiting_approval"));
    if (done && stuck && gated) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Now the blocking question — it lands in the Inbox and stays pending.
  await api(`/api/channels/${product.id}/messages`, { method: "POST", token: t, body: { text: "@Dev ask me which option" } });
  for (let i = 0; i < 10; i++) {
    const s = await api("/api/state", { token: t });
    if (s.questions.some((q) => q.status === "pending")) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const s = await api("/api/state", { token: t });
  console.log("Seeded the Atrium demo org:");
  console.log("  people:     Yosri (admin), Sara (member, team Engineering)");
  console.log(`  teams:      Engineering, Finance (${fin.id.slice(0, 8)}…)`);
  console.log("  channel:    #product (chat incl. a blocking @Dev question), DM with Dev");
  console.log("  agents:     Dev + Scout (mock driver, network allowlists)");
  console.log("  connectors: SharePoint org memory (synced), Confluence team memory (synced), Jira agent, Outlook disconnected");
  console.log(`  goals:      ${s.goals.map((g) => `"${g.name}" [${g.status}]`).join(", ")}`);
  console.log(`  pipelines:  ${s.pipelines.map((p) => `"${p.name}" [${p.status}]`).join(", ")}`);
  console.log(`  memory:     ${s.memory.length} entries, inbox/questions: ${s.inbox.length}/${s.questions.length}`);
  console.log(`\nOpen ${BASE} and log in as: Yosri`);
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
