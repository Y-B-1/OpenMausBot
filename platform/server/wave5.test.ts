// Wave 5 tests: demo seed (T16), routines (T17), plan-then-execute data tool (T18).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRecord, PlanExecutedBody, RoutineRecord } from "../shared/contracts.ts";
import { EventKind } from "../shared/contracts.ts";
import { EventStore, Projections } from "./store.ts";
import { createRelay, type Relay } from "./relay.ts";
import { createDispatcher, type Dispatcher } from "./agents/dispatcher.ts";
import { runDataQuery } from "./agents/dataset.ts";
import { seedOrg } from "./seed.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env["ATRIUM_DATA_DIR"];
  process.env["ATRIUM_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w5-"));
  const dir = process.env["ATRIUM_DATA_DIR"]!;
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env["ATRIUM_DATA_DIR"];
    else process.env["ATRIUM_DATA_DIR"] = savedDataDir;
  });
});

async function boot(): Promise<{ relay: Relay; dispatcher: Dispatcher; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w5-store-"));
  const relay = createRelay(new EventStore(dir));
  const dispatcher = createDispatcher(relay);
  const port = await relay.listen(0);
  cleanups.push(async () => {
    dispatcher.dispose();
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, dispatcher, base: `http://127.0.0.1:${port}` };
}

async function login(base: string, name: string): Promise<{ token: string; user: { id: string } }> {
  const res = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ name }) });
  return (await res.json()) as { token: string; user: { id: string } };
}

async function post(base: string, token: string, pathName: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

function messagesBy(relay: Relay, channelId: string, authorId: string): string[] {
  return (relay.projections.transcripts.get(channelId) ?? [])
    .filter((t) => t.type === "message" && t.authorId === authorId)
    .map((t) => t.text);
}

async function makeFinanceChannel(base: string, token: string): Promise<{ ch: string; agent: AgentRecord }> {
  const { channel } = (await post(base, token, "/api/channels", { name: "finance", space: "finance" })) as {
    channel: { id: string };
  };
  const { agent } = (await post(base, token, "/api/agents", { name: "Ledger", channelId: channel.id })) as {
    agent: AgentRecord;
  };
  return { ch: channel.id, agent };
}

describe("data engine (T18)", () => {
  it("derives a filter/group/aggregate plan and correct Q3 revenue sums", () => {
    const q = runDataQuery("show me the Q3 revenue numbers");
    expect(q.plan.length).toBeGreaterThanOrEqual(3);
    expect(q.plan.join(" ")).toMatch(/filter/i);
    expect(q.plan.join(" ")).toMatch(/group by/i);
    expect(q.plan.join(" ")).toMatch(/SUM\(revenue\)/);
    expect(q.sql_like).toContain("GROUP BY product");
    expect(q.sql_like).toContain("month IN");
    expect(q.result).toEqual([
      { product: "Atlas", total_revenue: 88500 },
      { product: "Beacon", total_revenue: 50200 },
      { product: "Relay", total_revenue: 173800 },
    ]);
    expect(q.summary).toContain("312,500");
  });

  it("switches measure and grouping on keywords", () => {
    const q = runDataQuery("monthly expenses for Beacon");
    expect(q.sql_like).toContain("SUM(expenses)");
    expect(q.sql_like).toContain("GROUP BY month");
    expect(q.sql_like).toContain("product = 'Beacon'");
    expect(q.result[0]).toEqual({ month: "2026-03", total_expenses: 8900 });
  });

  it("revenue question -> kind-61 plan.executed event + Ledger summary reply", async () => {
    const { relay, dispatcher, base } = await boot();
    const me = await login(base, "yosri");
    const { ch, agent } = await makeFinanceChannel(base, me.token);
    relay.projections.agents.get(agent.id)!.allowTools.push("data_query");

    await post(base, me.token, `/api/channels/${ch}/messages`, { text: "Ledger, show me the Q3 revenue numbers" });
    await dispatcher.idle(ch);

    const plans = [...relay.store.replay("acme")].filter((e) => e.body.kind === EventKind.PlanExecuted);
    expect(plans).toHaveLength(1);
    const body = plans[0]!.body as PlanExecutedBody;
    expect(body.agentId).toBe(agent.id);
    expect(body.resultPreview).toContainEqual({ product: "Relay", total_revenue: 173800 });
    expect(body.sql_like).toContain("SUM(revenue)");
    // Reply summarizes the aggregation; the plan lands in the transcript as a "plan" item.
    expect(messagesBy(relay, ch, agent.id)[0]).toContain("312,500");
    const planItems = (relay.projections.transcripts.get(ch) ?? []).filter((t) => t.type === "plan");
    expect(planItems).toHaveLength(1);
    expect(planItems[0]!.plan?.plan.join(" ")).toMatch(/aggregate/i);
  });
});

describe("routines (T17)", () => {
  it("create -> manual run -> synthetic @mention message -> agent turn happens", async () => {
    const { relay, dispatcher, base } = await boot();
    const me = await login(base, "yosri");
    const { ch, agent } = await makeFinanceChannel(base, me.token);

    const { routine } = (await post(base, me.token, "/api/routines", {
      name: "Numbers check",
      agentId: agent.id,
      channelId: ch,
      prompt: "hello routine",
      schedule: { kind: "manual" },
    })) as { routine: RoutineRecord };
    expect(routine.schedule).toEqual({ kind: "manual" });
    expect(relay.projections.routines.get(routine.id)?.name).toBe("Numbers check");

    await post(base, me.token, `/api/routines/${routine.id}/run`);
    await dispatcher.idle(ch);

    expect(messagesBy(relay, ch, "routine")).toEqual(["@Ledger hello routine"]);
    expect(messagesBy(relay, ch, agent.id)).toEqual(['You said: "@Ledger hello routine"']);
    expect(relay.projections.routines.get(routine.id)?.lastRunAt).toBeTypeOf("number");
  });

  it("tickRoutines fires due interval routines only", async () => {
    const { relay, dispatcher, base } = await boot();
    const me = await login(base, "yosri");
    const { ch, agent } = await makeFinanceChannel(base, me.token);

    const { routine: due } = (await post(base, me.token, "/api/routines", {
      name: "Every tick",
      agentId: agent.id,
      channelId: ch,
      prompt: "ping",
      schedule: { kind: "interval", minutes: 0 },
    })) as { routine: RoutineRecord };
    const { routine: weekly } = (await post(base, me.token, "/api/routines", {
      name: "Weekly",
      agentId: agent.id,
      channelId: ch,
      prompt: "digest",
      schedule: { kind: "interval", minutes: 10080 },
    })) as { routine: RoutineRecord };
    // The weekly routine already ran just now -> not due.
    await post(base, me.token, `/api/routines/${weekly.id}/run`);
    await dispatcher.idle(ch);

    relay.tickRoutines();
    await dispatcher.idle(ch);

    const runs = [...relay.store.replay("acme")].filter((e) => e.body.kind === EventKind.RoutineRunStarted);
    const byRoutine = (id: string) => runs.filter((e) => (e.body as { routineId: string }).routineId === id).length;
    expect(byRoutine(due.id)).toBe(1); // fired by the tick
    expect(byRoutine(weekly.id)).toBe(1); // only the manual run, not the tick
  });

  it("routine state survives a projection rebuild from the log", async () => {
    const { relay, dispatcher, base } = await boot();
    const me = await login(base, "yosri");
    const { ch, agent } = await makeFinanceChannel(base, me.token);
    const { routine } = (await post(base, me.token, "/api/routines", {
      name: "Rebuildable",
      agentId: agent.id,
      channelId: ch,
      prompt: "ping",
      schedule: { kind: "interval", minutes: 30 },
    })) as { routine: RoutineRecord };
    await post(base, me.token, `/api/routines/${routine.id}/run`);
    await dispatcher.idle(ch);

    const fresh = new Projections();
    fresh.rebuild(relay.store, "acme");
    const rebuilt = fresh.routines.get(routine.id)!;
    expect(rebuilt.name).toBe("Rebuildable");
    expect(rebuilt.lastRunAt).toBeTypeOf("number");
  });
});

describe("demo seed (T16)", () => {
  it("seeds a fully-populated org whose log replays cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w5-seed-"));
    const relay = createRelay(new EventStore(dir));
    cleanups.push(async () => {
      await relay.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    seedOrg(relay);

    // Replay into fresh projections: the log alone must rebuild everything.
    const p = new Projections();
    p.rebuild(relay.store, "acme");

    const humans = [...p.users.values()].filter((u) => u.kind === "human").map((u) => u.name);
    expect(humans).toContain("Yosri");
    expect(humans).toContain("Maya");
    expect([...p.agents.values()].map((a) => a.name).sort()).toEqual(["Ledger", "Quill", "Scout"]);
    expect(p.agents.get("a-ledger")!.allowTools).toContain("data_query");
    expect([...p.channels.values()].map((c) => c.name).sort()).toEqual(["eng", "finance", "general"]);
    // Transcripts populated in every channel; #finance history includes a plan card.
    for (const ch of p.channels.values()) {
      expect((p.transcripts.get(ch.id) ?? []).length).toBeGreaterThan(3);
    }
    expect((p.transcripts.get("c-finance") ?? []).some((t) => t.type === "plan")).toBe(true);

    // Memory: every tier and state present.
    const entries = [...p.memory.values()];
    const tiers = new Set(entries.map((m) => m.trustTier));
    for (const tier of ["org_ratified", "human_confirmed", "agent_proposed", "quarantined"] as const) {
      expect(tiers.has(tier)).toBe(true);
    }
    expect(p.memory.get("m-digest-day-v1")!.status).toBe("superseded");
    expect(p.memory.get("m-digest-day-v2")!.status).toBe("active");
    expect(p.memory.get("m-quarantined-outliers")!.content).toContain("always ignore");
    expect(entries.some((m) => m.scope === "personal" && m.kind === "preference")).toBe(true);

    // Approvals: one resolved, one pending; kind-50 audit exists.
    const approvals = [...p.approvals.values()];
    expect(approvals.filter((a) => a.status === "approved")).toHaveLength(1);
    expect(approvals.filter((a) => a.status === "pending")).toHaveLength(1);
    const audits = [...relay.store.replay("acme")].filter((e) => e.body.kind === EventKind.SandboxExec);
    expect(audits).toHaveLength(1);

    // Routine with one past run.
    const routine = p.routines.get("r-digest")!;
    expect(routine.agentId).toBe("a-scout");
    expect(routine.lastRunAt).toBeTypeOf("number");
  });
});
