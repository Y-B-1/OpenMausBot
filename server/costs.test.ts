import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CostManager, dayKey, type CostManagerOptions, type CostSource } from "./costs.ts";
import type { RuntimeEvent } from "./contracts.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-costs-"));
  dirs.push(dir);
  return join(dir, "costs.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime(), maxEntries?: number) {
  let now = start;
  const sources = new Map<string, CostSource>();
  const bots = new Map<string, string>();
  const emitted: any[] = [];
  const options: CostManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    classify: (threadId) => sources.get(threadId) ?? "chat",
    botFor: (threadId) => bots.get(threadId) ?? null,
    ...(maxEntries ? { maxEntries } : {}),
  };
  const manager = new CostManager(options);
  return {
    manager,
    options,
    emitted,
    setSource: (threadId: string, source: CostSource) => sources.set(threadId, source),
    setBot: (threadId: string, botId: string) => bots.set(threadId, botId),
    advance: (ms: number) => (now += ms),
  };
}

function base(threadId: string): Omit<RuntimeEvent, "type"> {
  return {
    eventId: `ev-${Math.random()}`,
    provider: "fake" as any,
    threadId,
    createdAt: new Date().toISOString(),
  };
}

function completeTurn(m: CostManager, threadId: string, cost: number | null | undefined) {
  m.handleRuntimeEvent({ ...base(threadId), type: "turn.completed", ok: true, cost } as RuntimeEvent);
}

describe("CostManager", () => {
  it("tees a turn.completed cost into a ledger entry with bot, model and source", () => {
    const h = harness();
    h.setBot("t-1", "maus-1");
    h.setSource("t-1", "goal");
    h.manager.handleRuntimeEvent({
      ...base("t-1"),
      type: "session.started",
      sessionId: "s1",
      model: "claude-sonnet",
    } as RuntimeEvent);
    completeTurn(h.manager, "t-1", 0.12);
    const summary = h.manager.summary();
    expect(summary.recent).toHaveLength(1);
    expect(summary.recent[0]).toMatchObject({
      threadId: "t-1",
      botId: "maus-1",
      costUsd: 0.12,
      model: "claude-sonnet",
      source: "goal",
    });
    expect(h.emitted[0]?.kind).toBe("cost");
  });

  it("ignores turns without a reported cost and non-turn events", () => {
    const h = harness();
    completeTurn(h.manager, "t-1", null);
    completeTurn(h.manager, "t-1", undefined);
    h.manager.handleRuntimeEvent({ ...base("t-1"), type: "turn.started" } as RuntimeEvent);
    expect(h.manager.summary().totals.turns).toBe(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("attributes each thread through the classifier", () => {
    const h = harness();
    h.setSource("t-goal", "goal");
    h.setSource("t-pipe", "pipeline");
    h.setSource("t-rout", "routine");
    completeTurn(h.manager, "t-goal", 0.1);
    completeTurn(h.manager, "t-pipe", 0.2);
    completeTurn(h.manager, "t-rout", 0.3);
    completeTurn(h.manager, "t-chat", 0.4);
    const { bySource } = h.manager.summary();
    expect(bySource.goal).toBeCloseTo(0.1);
    expect(bySource.pipeline).toBeCloseTo(0.2);
    expect(bySource.routine).toBeCloseTo(0.3);
    expect(bySource.chat).toBeCloseTo(0.4);
  });

  it("aggregates totals by day, bot and source", () => {
    const h = harness();
    h.setBot("t-1", "maus-1");
    h.setBot("t-2", "maus-2");
    completeTurn(h.manager, "t-1", 1);
    h.advance(-8 * 24 * 60 * 60_000); // 8 days ago — outside the 7-day window
    completeTurn(h.manager, "t-2", 2);
    h.advance(8 * 24 * 60 * 60_000);
    completeTurn(h.manager, "t-2", 0.5);
    const s = h.manager.summary();
    expect(s.totals.allTimeUsd).toBeCloseTo(3.5);
    expect(s.totals.todayUsd).toBeCloseTo(1.5);
    expect(s.totals.last7DaysUsd).toBeCloseTo(1.5);
    expect(s.totals.turns).toBe(3);
    expect(s.byBot).toEqual([
      { botId: "maus-2", costUsd: 2.5, turns: 2 },
      { botId: "maus-1", costUsd: 1, turns: 1 },
    ]);
    expect(s.byDay.find((d) => d.day === dayKey(Date.now() - 0))).toBeTruthy();
    expect(s.byDay[0]!.turns).toBe(2); // newest day first
  });

  it("collapses overflow rows into daily rollups that keep the totals", () => {
    const h = harness(undefined, 20); // cap 20 rows; 30 writes → 10 collapse
    h.setBot("t-1", "maus-1");
    h.setSource("t-1", "routine");
    for (let i = 0; i < 30; i++) completeTurn(h.manager, "t-1", 0.01);
    const s = h.manager.summary();
    expect(s.totals.turns).toBe(30);
    expect(s.totals.allTimeUsd).toBeCloseTo(0.3);
    expect(s.bySource.routine).toBeCloseTo(0.3);
    expect(s.byBot[0]!.botId).toBe("maus-1");
    expect(s.byBot[0]!.costUsd).toBeCloseTo(0.3); // rolled-up spend still counted
    expect(s.recent).toHaveLength(20);
    // the rollup survives a restart too
    const reloaded = new CostManager(h.options);
    expect(reloaded.summary().totals.turns).toBe(30);
  });

  it("persists entries and rollups across a restart", () => {
    const h = harness();
    h.setBot("t-1", "maus-1");
    completeTurn(h.manager, "t-1", 0.25);
    completeTurn(h.manager, "t-1", 0.75);
    const reloaded = new CostManager(h.options);
    const s = reloaded.summary();
    expect(s.totals.allTimeUsd).toBeCloseTo(1);
    expect(s.totals.turns).toBe(2);
    expect(s.recent[0]!.botId).toBe("maus-1");
  });
});
