import { describe, expect, it } from "vitest";

import { computeBoard, type BoardInput } from "./board";
import type { Goal } from "./goals";
import type { RoutineRun } from "./routines";

const guardrails = { maxSessions: 10, spendCapUsd: 5, wallClockMinutes: 120, stuckThreshold: 3 };

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    name: "Ship it",
    botId: "b1",
    criteria: [{ id: "c1", text: "done?", done: false }],
    guardrails,
    status: "running",
    sessions: 1,
    spentUsd: 0,
    stuck: 0,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function run(over: Partial<RoutineRun>): RoutineRun {
  return {
    id: "r1",
    routineId: "rt1",
    routineName: "Daily digest",
    botId: "b1",
    runOn: "maus",
    scheduledFor: 5,
    status: "queued",
    manual: false,
    createdAt: 5,
    ...over,
  };
}

function input(over: Partial<BoardInput>): BoardInput {
  return {
    bots: [{ id: "b1", threadId: "t1", name: "Maus", tasks: [{ threadId: "t1", title: "Fix bug", createdAt: 3 }] }],
    goals: [],
    inboxItems: [],
    inboxQuestions: [],
    routineRuns: [],
    ...over,
  };
}

describe("computeBoard", () => {
  it("puts a busy bot's active task in progress, skips idle and hidden bots", () => {
    const board = computeBoard(
      input({
        bots: [
          { id: "b1", threadId: "t1", name: "Maus", busy: true, tasks: [{ threadId: "t1", title: "Fix bug", createdAt: 3 }] },
          { id: "b2", threadId: "t2", name: "Idle", tasks: [{ threadId: "t2", title: "Old chat", createdAt: 1 }] },
          { id: "b3", threadId: "t3", name: "Ghost", busy: true, hidden: true },
        ],
      }),
    );
    expect(board.inProgress).toHaveLength(1);
    expect(board.inProgress[0]).toMatchObject({
      kind: "task",
      title: "Fix bug",
      nav: { view: "chat", botId: "b1", threadId: "t1" },
    });
    expect(board.queued).toHaveLength(0);
  });

  it("maps goal statuses to honest columns", () => {
    const board = computeBoard(
      input({
        goals: [
          goal({ id: "g1", status: "running" }),
          goal({ id: "g2", status: "paused" }),
          goal({ id: "g3", status: "done" }),
          goal({ id: "g4", status: "halted", haltReason: "spend cap" }),
          goal({ id: "g5", status: "cancelled" }),
        ],
      }),
    );
    expect(board.inProgress.map((c) => c.id)).toEqual(["goal:g1"]);
    expect(board.queued.map((c) => c.id)).toEqual(["goal:g2"]);
    expect(board.done.map((c) => c.id)).toEqual(["goal:g3"]);
    expect(board.waiting.map((c) => c.id)).toEqual(["goal:g4"]);
    expect(board.waiting[0]!.subtitle).toContain("spend cap");
    expect(board.halted.map((c) => c.id)).toEqual(["goal:g5"]);
  });

  it("puts pending questions and open inbox items in waiting, settled ones nowhere", () => {
    const board = computeBoard(
      input({
        inboxQuestions: [
          { id: "q1", botId: "b1", prompt: "Deploy?", options: [], ts: 9, status: "pending" },
          { id: "q2", botId: "b1", prompt: "Old", options: [], ts: 1, status: "answered" },
        ],
        inboxItems: [
          { id: "i1", botId: "b1", text: "FYI", ts: 8, status: "open" },
          { id: "i2", botId: "b1", text: "Old", ts: 2, status: "replied" },
        ],
      }),
    );
    expect(board.waiting.map((c) => c.id)).toEqual(["question:q1", "note:i1"]);
    expect(board.waiting[0]!.nav).toEqual({ view: "inbox" });
  });

  it("maps routine run statuses across columns", () => {
    const board = computeBoard(
      input({
        routineRuns: [
          run({ id: "r1", status: "queued" }),
          run({ id: "r2", status: "running" }),
          run({ id: "r3", status: "waiting" }),
          run({ id: "r4", status: "completed" }),
          run({ id: "r5", status: "failed", error: "boom" }),
          run({ id: "r6", status: "missed" }),
        ],
      }),
    );
    expect(board.queued.map((c) => c.id)).toEqual(["routine:r1"]);
    expect(board.inProgress.map((c) => c.id).sort()).toEqual(["routine:r2", "routine:r3"]);
    expect(board.done.map((c) => c.id)).toEqual(["routine:r4"]);
    expect(board.halted.map((c) => c.id).sort()).toEqual(["routine:r5", "routine:r6"]);
    expect(board.halted.find((c) => c.id === "routine:r5")!.subtitle).toContain("boom");
    expect(board.halted.find((c) => c.id === "routine:r6")!.subtitle).toContain("missed");
  });

  it("orders each column newest first", () => {
    const board = computeBoard(
      input({
        goals: [goal({ id: "g1", updatedAt: 1 }), goal({ id: "g2", updatedAt: 9 })],
      }),
    );
    expect(board.inProgress.map((c) => c.id)).toEqual(["goal:g2", "goal:g1"]);
  });
});
