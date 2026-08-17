import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineManager, type PipelineManagerOptions, type PipelineRun, type TemplateStep } from "./pipelines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-pipelines-"));
  dirs.push(dir);
  return join(dir, "pipelines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const interrupted: string[] = [];
  const gates: Array<{ run: PipelineRun; step: TemplateStep; token: string }> = [];
  const resolved: Array<{ runId: string; token: string; behavior: string }> = [];
  const options: PipelineManagerOptions = {
    file: tempFile(),
    now: () => now,
    approvalTtlMinutes: 60,
    botState: () => bot,
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (botId, threadId, prompt) => {
      started.push({ botId, threadId, prompt });
    },
    interruptTurn: async (_botId, threadId) => {
      interrupted.push(threadId);
    },
    onGate: (run, step, token) => gates.push({ run, step, token }),
    onGateResolved: (run, token, behavior) => resolved.push({ runId: run.id, token, behavior }),
  };
  const manager = new PipelineManager(options);
  return {
    manager,
    options,
    started,
    interrupted,
    gates,
    resolved,
    advance: (ms: number) => (now += ms),
    setBot: (value: typeof bot) => (bot = value),
  };
}

/** Feed the manager the runtime events of one finished step turn. */
function completeTurn(
  h: ReturnType<typeof harness>,
  threadId: string,
  reply: string,
  opts: { ok?: boolean } = {},
) {
  const base = { eventId: `ev-${Math.random()}`, provider: "fake", threadId, createdAt: new Date().toISOString() };
  h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: reply });
  h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: opts.ok ?? true });
}

function twoStepTemplate(h: ReturnType<typeof harness>, gateSecond = false) {
  return h.manager.createTemplate({
    name: "Ship it",
    steps: [
      { title: "Draft", prompt: "Write the draft.", botId: "maus-1" },
      { title: "Publish", prompt: "Publish the draft.", botId: "maus-2", gate: gateSecond ? "approval" : undefined },
    ],
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PipelineManager", () => {
  it("validates templates", () => {
    const h = harness();
    expect(() => h.manager.createTemplate({ name: "", steps: [] })).toThrow();
    expect(() => h.manager.createTemplate({ name: "Empty", steps: [] })).toThrow();
    expect(() =>
      h.manager.createTemplate({ name: "Bad step", steps: [{ title: "", prompt: "x", botId: "b" }] }),
    ).toThrow();
    h.setBot("missing");
    expect(() =>
      h.manager.createTemplate({ name: "Ghost", steps: [{ title: "T", prompt: "x", botId: "gone" }] }),
    ).toThrow();
  });

  it("runs steps sequentially, feeding each step's output into the next prompt", async () => {
    const h = harness();
    const template = twoStepTemplate(h);
    h.manager.startRun({ templateId: template.id, input: "The Q3 report" });
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.botId).toBe("maus-1");
    expect(h.started[0]!.prompt).toContain("Write the draft.");
    expect(h.started[0]!.prompt).toContain("The Q3 report");

    completeTurn(h, "thread-1", "Here is the draft: hello world");
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(h.started[1]!.botId).toBe("maus-2");
    expect(h.started[1]!.threadId).toBe("thread-2"); // fresh task per step
    expect(h.started[1]!.prompt).toContain("Output of the previous step:");
    expect(h.started[1]!.prompt).toContain("Here is the draft: hello world");

    completeTurn(h, "thread-2", "Published.");
    const run = h.manager.listRuns()[0]!;
    expect(run.status).toBe("done");
    expect(run.stepStates).toEqual(["done", "done"]);
    expect(run.stepOutputs).toEqual(["Here is the draft: hello world", "Published."]);
  });

  it("suspends at a gate before the gated step runs, then approve resumes", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "Draft done");
    await h.manager.tick();

    // gated step 2 has NOT started; the run is suspended on a token
    expect(h.started).toHaveLength(1);
    const suspended = h.manager.getRun(run.id)!;
    expect(suspended.status).toBe("waiting_approval");
    expect(suspended.approval).toMatchObject({ stepIndex: 1 });
    expect(h.gates).toHaveLength(1);
    expect(h.gates[0]!.step.title).toBe("Publish");

    const approved = h.manager.approve(run.id, h.gates[0]!.token);
    expect(approved!.status).toBe("running");
    expect(h.resolved).toEqual([{ runId: run.id, token: h.gates[0]!.token, behavior: "Approve" }]);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    completeTurn(h, "thread-2", "Published");
    expect(h.manager.getRun(run.id)!.status).toBe("done");
  });

  it("reject cancels the remaining steps", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "Draft done");
    await h.manager.tick();

    const rejected = h.manager.reject(run.id, h.gates[0]!.token);
    expect(rejected).toMatchObject({ status: "rejected", haltReason: "gate rejected at step 2" });
    expect(h.resolved[0]!.behavior).toBe("Reject");
    await h.manager.tick();
    expect(h.started).toHaveLength(1); // the gated step never ran
  });

  it("a wrong token settles nothing", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "Draft done");
    await h.manager.tick();
    expect(h.manager.approve(run.id, "not-the-token")).toBeNull();
    expect(h.manager.reject(run.id, "not-the-token")).toBeNull();
    expect(h.manager.getRun(run.id)!.status).toBe("waiting_approval");
  });

  it("an expired gate rejects the run", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "Draft done");
    await h.manager.tick();
    const token = h.gates[0]!.token;

    h.advance(61 * 60_000);
    expect(h.manager.approve(run.id, token)).toBeNull(); // too late
    const expired = h.manager.getRun(run.id)!;
    expect(expired.status).toBe("rejected");
    expect(expired.haltReason).toContain("approval expired");
    expect(h.resolved[0]!.behavior).toBe("Expired");
  });

  it("the tick sweeps expired gates even when nobody answers", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "Draft done");
    await h.manager.tick();
    h.advance(61 * 60_000);
    await h.manager.tick();
    expect(h.manager.getRun(run.id)!.status).toBe("rejected");
  });

  it("a failed step turn fails the run", async () => {
    const h = harness();
    const template = twoStepTemplate(h);
    h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    completeTurn(h, "thread-1", "boom", { ok: false });
    const run = h.manager.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.haltReason).toContain('step 1 ("Draft") failed');
  });

  it("a dispatch error fails the run", async () => {
    const h = harness();
    const template = twoStepTemplate(h);
    h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    h.manager.failStep("thread-1", "provider unavailable");
    const run = h.manager.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.haltReason).toContain("provider unavailable");
  });

  it("waits behind a busy bot instead of double-dispatching", async () => {
    const h = harness();
    const template = twoStepTemplate(h);
    h.manager.startRun({ templateId: template.id });
    h.setBot("busy");
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    await h.manager.tick(); // step still in flight
    expect(h.started).toHaveLength(1);
  });

  it("cancel interrupts the in-flight step", async () => {
    const h = harness();
    const template = twoStepTemplate(h);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick();
    await h.manager.cancel(run.id);
    expect(h.manager.getRun(run.id)!.status).toBe("cancelled");
    expect(h.interrupted).toEqual(["thread-1"]);
    // a completed turn after cancel changes nothing
    completeTurn(h, "thread-1", "too late");
    expect(h.manager.getRun(run.id)!.status).toBe("cancelled");
  });

  it("runtime events never trigger runs (no-retrigger rule)", async () => {
    const h = harness();
    twoStepTemplate(h);
    completeTurn(h, "thread-that-nobody-started", "hello");
    expect(h.manager.listRuns()).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  it("survives a restart: mid-turn step reruns, a pending gate is preserved", async () => {
    const h = harness();
    const template = twoStepTemplate(h, true);
    const run = h.manager.startRun({ templateId: template.id });
    await h.manager.tick(); // step 1 in flight

    const reloadedMidTurn = new PipelineManager(h.options);
    const revived = reloadedMidTurn.getRun(run.id)!;
    expect(revived.stepStates[0]).toBe("pending"); // in-flight turn was lost
    const before = h.started.length;
    await reloadedMidTurn.tick();
    expect(h.started).toHaveLength(before + 1); // step 1 runs again

    completeTurn({ ...h, manager: reloadedMidTurn } as ReturnType<typeof harness>, h.started.at(-1)!.threadId, "Draft");
    await reloadedMidTurn.tick(); // suspends at the gate

    const reloadedGated = new PipelineManager(h.options);
    const gated = reloadedGated.getRun(run.id)!;
    expect(gated.status).toBe("waiting_approval");
    expect(gated.approval?.token).toBeTruthy();
    expect(reloadedGated.approve(run.id, gated.approval!.token)!.status).toBe("running");
  });
});
