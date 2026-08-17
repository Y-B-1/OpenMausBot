import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalManager, replyMarksDone, type GoalManagerOptions } from "./goals.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-goals-"));
  dirs.push(dir);
  return join(dir, "goals.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const interrupted: string[] = [];
  const emitted: any[] = [];
  const options: GoalManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (botId, threadId, prompt) => {
      started.push({ botId, threadId, prompt });
    },
    interruptTurn: async (_botId, threadId) => {
      interrupted.push(threadId);
    },
  };
  const manager = new GoalManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    interrupted,
    setNow: (value: number) => (now = value),
    advance: (ms: number) => (now += ms),
    setBot: (value: typeof bot) => (bot = value),
  };
}

/** Feed the manager the runtime events of one finished session. */
function completeTurn(
  h: ReturnType<typeof harness>,
  threadId: string,
  reply: string,
  opts: { ok?: boolean; cost?: number } = {},
) {
  const base = { eventId: `ev-${Math.random()}`, provider: "fake", threadId, createdAt: new Date().toISOString() };
  h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: reply });
  h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: opts.ok ?? true, cost: opts.cost });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("replyMarksDone", () => {
  it("accepts a DONE line anywhere, rejects everything else", () => {
    expect(replyMarksDone("DONE — deployed.")).toBe(true);
    expect(replyMarksDone("I finished the work.\ndone")).toBe(true);
    expect(replyMarksDone("BLOCKED: need credentials")).toBe(false);
    expect(replyMarksDone("The job is not done yet")).toBe(false);
    expect(replyMarksDone(undefined)).toBe(false);
  });
});

describe("GoalManager", () => {
  it("runs sessions per criterion and completes when the bot reports DONE on each", async () => {
    const h = harness();
    h.manager.create({ name: "Ship the docs", botId: "maus-1", criteria: ["Write draft", "Publish it"] });
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.prompt).toContain("[>] Write draft");

    completeTurn(h, "thread-1", "Draft written.\nDONE", { cost: 0.01 });
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(h.started[1]!.threadId).toBe("thread-1"); // same task thread throughout
    expect(h.started[1]!.prompt).toContain("[x] Write draft");
    expect(h.started[1]!.prompt).toContain("[>] Publish it");

    completeTurn(h, "thread-1", "DONE published", { cost: 0.02 });
    await h.manager.tick();
    const goal = h.manager.list()[0]!;
    expect(goal).toMatchObject({ status: "done", sessions: 2 });
    expect(goal.spentUsd).toBeCloseTo(0.03);
    expect(goal.criteria.every((c) => c.done)).toBe(true);
  });

  it("halts at the session cap", async () => {
    const h = harness();
    h.manager.create({
      name: "Impossible",
      botId: "maus-1",
      criteria: ["Never satisfied"],
      guardrails: { maxSessions: 2, stuckThreshold: 10 },
    });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED still working");
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED again");
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(h.manager.list()[0]).toMatchObject({ status: "halted", haltReason: "session cap reached (2)" });
  });

  it("halts at the spend cap using provider-reported turn cost", async () => {
    const h = harness();
    h.manager.create({
      name: "Expensive",
      botId: "maus-1",
      criteria: ["Big job"],
      guardrails: { spendCapUsd: 0.05, maxSessions: 50, stuckThreshold: 50 },
    });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED", { cost: 0.06 });
    await h.manager.tick();
    const goal = h.manager.list()[0]!;
    expect(goal.status).toBe("halted");
    expect(goal.haltReason).toContain("spend cap reached");
  });

  it("halts when the wall clock runs out", async () => {
    const h = harness();
    h.manager.create({
      name: "Slow",
      botId: "maus-1",
      criteria: ["Take forever"],
      guardrails: { wallClockMinutes: 30, stuckThreshold: 50, maxSessions: 50 },
    });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED");
    h.advance(31 * 60_000);
    await h.manager.tick();
    expect(h.manager.list()[0]).toMatchObject({ status: "halted", haltReason: "wall clock exceeded (30m)" });
  });

  it("halts after consecutive sessions without progress (stuck)", async () => {
    const h = harness();
    h.manager.create({
      name: "Stuck goal",
      botId: "maus-1",
      criteria: ["Blocked forever"],
      guardrails: { stuckThreshold: 2, maxSessions: 50 },
    });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED");
    await h.manager.tick();
    completeTurn(h, "thread-1", "no progress");
    await h.manager.tick();
    expect(h.manager.list()[0]).toMatchObject({
      status: "halted",
      haltReason: "stuck: 2 sessions without progress",
      stuck: 2,
    });
  });

  it("a DONE reply resets the stuck counter", async () => {
    const h = harness();
    h.manager.create({
      name: "Recovers",
      botId: "maus-1",
      criteria: ["First", "Second"],
      guardrails: { stuckThreshold: 2, maxSessions: 50 },
    });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED");
    await h.manager.tick();
    completeTurn(h, "thread-1", "DONE first finished");
    await h.manager.tick();
    const goal = h.manager.list()[0]!;
    expect(goal.stuck).toBe(0);
    expect(goal.criteria[0]!.done).toBe(true);
    expect(goal.status).toBe("running");
  });

  it("waits behind a busy bot instead of double-dispatching", async () => {
    const h = harness();
    h.setBot("busy");
    h.manager.create({ name: "Patient", botId: "maus-1", criteria: ["Wait your turn"] });
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    // no second session while one is in flight
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
  });

  it("pause stops the next session; resume continues; cancel interrupts", async () => {
    const h = harness();
    const goal = h.manager.create({ name: "Controlled", botId: "maus-1", criteria: ["Step"] });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED");
    h.manager.pause(goal.id);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);

    h.manager.resume(goal.id);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);

    await h.manager.cancel(goal.id);
    expect(h.manager.list()[0]!.status).toBe("cancelled");
    expect(h.interrupted).toEqual(["thread-1"]);
    // a completed turn after cancel changes nothing
    completeTurn(h, "thread-1", "DONE");
    expect(h.manager.list()[0]!.criteria[0]!.done).toBe(false);
  });

  it("a dispatch error counts toward stuck instead of retrying forever", async () => {
    const h = harness();
    h.manager.create({
      name: "Broken engine",
      botId: "maus-1",
      criteria: ["Anything"],
      guardrails: { stuckThreshold: 1, maxSessions: 50 },
    });
    await h.manager.tick();
    h.manager.failSession("thread-1", "provider unavailable");
    await h.manager.tick();
    const goal = h.manager.list()[0]!;
    expect(goal.status).toBe("halted");
    expect(goal.lastReply).toContain("provider unavailable");
  });

  it("persists across a reload and keeps running", async () => {
    const h = harness();
    h.manager.create({ name: "Durable", botId: "maus-1", criteria: ["Persist"] });
    await h.manager.tick();
    completeTurn(h, "thread-1", "BLOCKED");
    await h.manager.tick(); // original dispatches session 2 and holds it in flight

    const reloaded = new GoalManager(h.options);
    const goal = reloaded.list()[0]!;
    expect(goal).toMatchObject({ name: "Durable", status: "running", sessions: 2, stuck: 1, threadId: "thread-1" });
    const before = h.started.length;
    await reloaded.tick();
    expect(h.started).toHaveLength(before + 1); // fresh session after restart
  });

  it("rejects unusable input", () => {
    const h = harness();
    expect(() => h.manager.create({ name: "", botId: "maus-1", criteria: ["x"] })).toThrow();
    expect(() => h.manager.create({ name: "No bot", botId: "", criteria: ["x"] })).toThrow();
    expect(() => h.manager.create({ name: "No criteria", botId: "maus-1", criteria: [] })).toThrow();
    h.setBot("missing");
    expect(() => h.manager.create({ name: "Ghost", botId: "maus-9", criteria: ["x"] })).toThrow();
  });
});
