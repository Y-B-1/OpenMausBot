// Wave 6 tests: inbox + ask_user (W6-A), goal loops + guardrails (W6-B),
// pipeline templates + approval gates (W6-C), egress allowlist + policy files
// (W6-D), costs + YAML export (W6-E).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRecord,
  GoalRecord,
  InboxItem,
  PipelineRun,
  QuestionRecord,
  TemplateRecord,
} from "../shared/contracts.ts";
import { EventStore } from "./store.ts";
import { createRelay, type Relay } from "./relay.ts";
import { createDispatcher, estimateTurnCost, type Dispatcher } from "./agents/dispatcher.ts";
import { createEngines, type Engines } from "./agents/engines.ts";
import { toYaml } from "./yaml.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env["ATRIUM_DATA_DIR"];
  process.env["ATRIUM_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w6-"));
  const dir = process.env["ATRIUM_DATA_DIR"]!;
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env["ATRIUM_DATA_DIR"];
    else process.env["ATRIUM_DATA_DIR"] = savedDataDir;
  });
});

async function boot(): Promise<{ relay: Relay; dispatcher: Dispatcher; engines: Engines; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w6-store-"));
  const relay = createRelay(new EventStore(dir));
  const dispatcher = createDispatcher(relay);
  const engines = createEngines(relay, dispatcher);
  const port = await relay.listen(0);
  cleanups.push(async () => {
    engines.dispose();
    dispatcher.dispose();
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, dispatcher, engines, base: `http://127.0.0.1:${port}` };
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

async function setup(agentBody: Record<string, unknown> = {}) {
  const booted = await boot();
  const { token, user } = await login(booted.base, "Yosri");
  const { channel } = (await post(booted.base, token, "/api/channels", { name: "ops", space: "general" })) as {
    channel: { id: string };
  };
  const { agent } = (await post(booted.base, token, "/api/agents", {
    name: "Dev",
    channelId: channel.id,
    ...agentBody,
  })) as { agent: AgentRecord };
  return { ...booted, token, userId: user.id, ch: channel.id, agent };
}

const say = (base: string, token: string, ch: string, text: string) =>
  post(base, token, `/api/channels/${ch}/messages`, { text });

// ---------- W6-A: inbox + ask_user ----------

describe("inbox (W6-A)", () => {
  it("inbox_send lands an open item; replying marks it replied and posts to the channel", async () => {
    const { relay, dispatcher, base, token, ch } = await setup();
    await say(base, token, ch, "@Dev please notify me when ready");
    await dispatcher.idle(ch);
    const items = [...relay.projections.inbox.values()];
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe("open");
    await post(base, token, `/api/inbox/${items[0]!.id}/reply`, { reply: "Looks good, carry on" });
    expect(relay.projections.inbox.get(items[0]!.id)!.status).toBe("replied");
    const transcript = relay.projections.transcripts.get(ch)!;
    expect(transcript.some((t) => t.text === "Looks good, carry on")).toBe(true);
  });

  it("ask_user blocks the turn until the human answers; option validated server-side", async () => {
    const { relay, dispatcher, base, token, ch, agent } = await setup();
    void say(base, token, ch, "@Dev ask me which option");
    // Wait for the question to be raised while the turn is still blocked.
    let q: QuestionRecord | undefined;
    for (let i = 0; i < 100 && !q; i++) {
      await new Promise((r) => setTimeout(r, 10));
      q = [...relay.projections.questions.values()][0];
    }
    expect(q).toBeDefined();
    expect(q!.options).toEqual(["Option A", "Option B"]);
    // Wrong answer is rejected.
    const bad = await post(base, token, `/api/questions/${q!.id}/answer`, { answer: "Option C" });
    expect(bad["error"]).toMatch(/one of the options/);
    // Right answer unblocks the agent.
    await post(base, token, `/api/questions/${q!.id}/answer`, { answer: "Option B" });
    await dispatcher.idle(ch);
    const replies = (relay.projections.transcripts.get(ch) ?? [])
      .filter((t) => t.type === "message" && t.authorId === agent.id)
      .map((t) => t.text);
    expect(replies.at(-1)).toContain("You chose: Option B");
    expect(relay.projections.questions.get(q!.id)!.status).toBe("answered");
  });
});

// ---------- W6-B: goals ----------

describe("goal loops (W6-B)", () => {
  it("runs sessions until every criterion is done, then completes", async () => {
    const { relay, engines, base, token, ch, agent } = await setup();
    const { goal } = (await post(base, token, "/api/goals", {
      name: "Ship field",
      spec: "spec text",
      criteria: ["field rendered", "tests green"],
      agentId: agent.id,
      channelId: ch,
    })) as { goal: GoalRecord };
    await engines.settled();
    const done = relay.projections.goals.get(goal.id)!;
    expect(done.status).toBe("done");
    expect(done.criteria.every((c) => c.done)).toBe(true);
    expect(done.sessions).toBe(2);
    expect(done.spentUsd).toBeGreaterThan(0);
  });

  it("halts on the stuck threshold when a criterion never progresses", async () => {
    const { relay, engines, base, token, ch, agent } = await setup();
    const { goal } = (await post(base, token, "/api/goals", {
      name: "Impossible",
      criteria: ["this is impossible to satisfy"],
      agentId: agent.id,
      channelId: ch,
      guardrails: { stuckThreshold: 2, maxSessions: 50 },
    })) as { goal: GoalRecord };
    await engines.settled();
    const halted = relay.projections.goals.get(goal.id)!;
    expect(halted.status).toBe("halted");
    expect(halted.haltReason).toMatch(/stuck/);
    expect(halted.sessions).toBe(2);
  });

  it("halts on the session cap before finishing endless work", async () => {
    const { relay, engines, base, token, ch, agent } = await setup();
    const { goal } = (await post(base, token, "/api/goals", {
      name: "Capped",
      criteria: ["impossible one", "impossible two"],
      agentId: agent.id,
      channelId: ch,
      guardrails: { maxSessions: 1, stuckThreshold: 99 },
    })) as { goal: GoalRecord };
    await engines.settled();
    const halted = relay.projections.goals.get(goal.id)!;
    expect(halted.status).toBe("halted");
    expect(halted.haltReason).toMatch(/session cap/);
  });

  it("halts on the spend cap", async () => {
    const { relay, engines, base, token, ch, agent } = await setup();
    const { goal } = (await post(base, token, "/api/goals", {
      name: "Cheap",
      criteria: ["impossible a", "impossible b", "impossible c"],
      agentId: agent.id,
      channelId: ch,
      guardrails: { spendCapUsd: 0.0000001, stuckThreshold: 99, maxSessions: 50 },
    })) as { goal: GoalRecord };
    await engines.settled();
    const halted = relay.projections.goals.get(goal.id)!;
    expect(halted.status).toBe("halted");
    expect(halted.haltReason).toMatch(/spend cap/);
    expect(halted.sessions).toBe(1); // one session spent more than the cap
  });
});

// ---------- W6-C: pipelines ----------

describe("pipeline templates (W6-C)", () => {
  it("runs steps in order, parks on the approval gate, resumes on advance", async () => {
    const { relay, engines, base, token, ch, agent } = await setup();
    const { template } = (await post(base, token, "/api/templates", {
      name: "Feature",
      steps: [
        { title: "Write spec", agentId: agent.id, prompt: "Write the spec.", requiresApproval: true },
        { title: "Implement", agentId: agent.id, prompt: "Implement it.", requiresApproval: false },
      ],
    })) as { template: TemplateRecord };
    const { run } = (await post(base, token, "/api/pipelines", {
      templateId: template.id,
      channelId: ch,
      input: "Add headline explainer",
    })) as { run: PipelineRun };
    await engines.settled();
    let state = relay.projections.pipelines.get(run.id)!;
    expect(state.stepStates[0]).toBe("awaiting_approval");
    expect(state.status).toBe("running");
    // Human approves the gated step.
    await post(base, token, `/api/pipelines/${run.id}/advance`);
    await engines.settled();
    state = relay.projections.pipelines.get(run.id)!;
    expect(state.stepStates).toEqual(["done", "done"]);
    expect(state.status).toBe("done");
    // Both step prompts flowed through the channel to the agent.
    const agentMsgs = (relay.projections.transcripts.get(ch) ?? []).filter(
      (t) => t.type === "message" && t.authorId === agent.id,
    );
    expect(agentMsgs.length).toBeGreaterThanOrEqual(2);
  });

  it("advance without a waiting gate is a 409", async () => {
    const { base, token, ch, agent } = await setup();
    const { template } = (await post(base, token, "/api/templates", {
      name: "NoGate",
      steps: [{ title: "One", agentId: agent.id, prompt: "Do.", requiresApproval: false }],
    })) as { template: TemplateRecord };
    const { run } = (await post(base, token, "/api/pipelines", { templateId: template.id, channelId: ch })) as {
      run: PipelineRun;
    };
    const res = await post(base, token, `/api/pipelines/${run.id}/advance`);
    expect(res["error"]).toMatch(/no step awaiting approval/);
  });
});

// ---------- W6-D: egress + files ----------

describe("egress allowlist + policy files (W6-D)", () => {
  it("denies fetches to hosts off the allowlist and audits the denial", async () => {
    const { relay, dispatcher, base, token, ch, agent } = await setup({ networkAllowlist: ["api.front.com"] });
    await say(base, token, ch, "@Dev fetch https://api.front.com/x");
    await dispatcher.idle(ch);
    await say(base, token, ch, "@Dev fetch https://github.com/secret");
    await dispatcher.idle(ch);
    const replies = (relay.projections.transcripts.get(ch) ?? [])
      .filter((t) => t.type === "message" && t.authorId === agent.id)
      .map((t) => t.text);
    expect(replies[0]).toContain("fetched https://api.front.com/x");
    expect(replies[1]).toMatch(/egress denied/);
  });

  it("agents with NO environment have no egress at all (fail closed)", async () => {
    const { relay, dispatcher, base, token, ch, agent } = await setup();
    await say(base, token, ch, "@Dev fetch https://api.front.com/x");
    await dispatcher.idle(ch);
    const replies = (relay.projections.transcripts.get(ch) ?? [])
      .filter((t) => t.type === "message" && t.authorId === agent.id)
      .map((t) => t.text);
    expect(replies[0]).toMatch(/egress denied/);
  });

  it("files_write is scoped, audited, and there is no delete path", async () => {
    const { relay, dispatcher, base, token, ch } = await setup();
    await say(base, token, ch, "@Dev save file notes.md: hello world");
    await dispatcher.idle(ch);
    const fileEvents = [...relay.store.replay("acme")].filter((e) => e.body.kind === 110);
    expect(fileEvents).toHaveLength(1);
    // Traversal is refused by the sandbox path check.
    await say(base, token, ch, "@Dev save file ../../escape.txt: nope");
    await dispatcher.idle(ch);
    const replies = (relay.projections.transcripts.get(ch) ?? []).filter((t) => t.type === "message").map((t) => t.text);
    expect(replies.at(-1)).toMatch(/escapes sandbox|failed/i);
  });
});

// ---------- W6-E: costs + YAML ----------

describe("costs + export (W6-E)", () => {
  it("records a deterministic cost per turn", async () => {
    const { relay, dispatcher, base, token, ch } = await setup();
    await say(base, token, ch, "@Dev hello there");
    await dispatcher.idle(ch);
    expect(relay.projections.costs).toHaveLength(1);
    expect(relay.projections.costs[0]!.estUsd).toBeGreaterThan(0);
    const { estUsd } = estimateTurnCost("claude-haiku-4-5", 4000);
    expect(estUsd).toBeCloseTo(0.004, 6);
  });

  it("exports agents, routines and templates as YAML", async () => {
    const { base, token, ch, agent } = await setup({ networkAllowlist: ["api.front.com"] });
    await post(base, token, "/api/templates", {
      name: "Feature",
      steps: [{ title: "Spec", agentId: agent.id, prompt: "Write spec.", requiresApproval: true }],
    });
    const res = await fetch(`${base}/api/export`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.headers.get("content-type")).toContain("yaml");
    const text = await res.text();
    expect(text).toContain("agents:");
    expect(text).toContain("name: Dev");
    expect(text).toContain("networkAllowlist:");
    expect(text).toContain("api.front.com");
    expect(text).toContain("templates:");
    expect(text).toContain("requiresApproval: true");
  });

  it("toYaml quotes awkward scalars and keeps simple ones bare", () => {
    const y = toYaml({ a: "plain value", b: 'needs "quoting": yes', n: 3, flag: true, empty: [] });
    expect(y).toContain("a: plain value");
    expect(y).toContain('b: "needs \\"quoting\\": yes"');
    expect(y).toContain("n: 3");
    expect(y).toContain("flag: true");
    expect(y).toContain("empty: []");
  });
});
