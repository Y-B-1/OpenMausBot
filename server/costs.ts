import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

// ── cost ledger (P8) ───────────────────────────────────────────────────
// A bus tee: every turn.completed that carries a provider-reported cost
// becomes one ledger entry. Attribution asks the engines that own detached
// tasks (goals/pipelines/routines) whose thread this was — everything else
// is plain chat. The tee only records; it never starts or changes turns.

export type CostSource = "chat" | "goal" | "pipeline" | "routine";

export interface CostEntry {
  id: string;
  ts: number;
  botId: string | null;
  threadId: string;
  costUsd: number;
  /** from the thread's session.started, when the driver reported one */
  model?: string;
  source: CostSource;
}

/** One collapsed day of pruned entries — totals survive, rows don't. */
export interface CostRollup {
  day: string; // YYYY-MM-DD (local)
  turns: number;
  costUsd: number;
  byBot: Record<string, number>;
  bySource: Partial<Record<CostSource, number>>;
}

export interface CostSummary {
  totals: { todayUsd: number; last7DaysUsd: number; allTimeUsd: number; turns: number };
  byBot: Array<{ botId: string; costUsd: number; turns: number }>;
  bySource: Record<CostSource, number>;
  byDay: Array<{ day: string; costUsd: number; turns: number }>;
  recent: CostEntry[];
}

interface CostFile {
  version: 1;
  entries: CostEntry[];
  rollups: CostRollup[];
}

export interface CostManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  /** which engine (if any) owns this thread right now */
  classify: (threadId: string) => CostSource;
  botFor: (threadId: string) => string | null;
  /** test seam: detailed rows kept before days collapse into rollups */
  maxEntries?: number;
}

/** Detailed rows kept before the oldest days collapse into rollups. */
const MAX_ENTRIES = 5_000;
const MAX_ROLLUP_DAYS = 365;
const MAX_MODEL_THREADS = 500;
const RECENT_LIMIT = 50;
const BY_DAY_LIMIT = 14;

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class CostManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: CostManagerOptions;
  private readonly maxEntries: number;
  /** newest first */
  private entries: CostEntry[] = [];
  private rollups: CostRollup[] = [];
  /** threadId → last reported model (bounded; insertion-ordered eviction) */
  private readonly modelByThread = new Map<string, string>();

  constructor(options: CostManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "costs.json");
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CostFile>;
      this.entries = Array.isArray(disk.entries) ? disk.entries : [];
      this.rollups = Array.isArray(disk.rollups) ? disk.rollups : [];
    } catch {
      this.entries = [];
      this.rollups = [];
    }
  }

  handleRuntimeEvent(event: RuntimeEvent) {
    if (event.type === "session.started") {
      if (event.model) {
        this.modelByThread.delete(event.threadId);
        this.modelByThread.set(event.threadId, event.model);
        if (this.modelByThread.size > MAX_MODEL_THREADS) {
          const oldest = this.modelByThread.keys().next().value;
          if (oldest !== undefined) this.modelByThread.delete(oldest);
        }
      }
      return;
    }
    if (event.type !== "turn.completed" || typeof event.cost !== "number") return;
    const model = this.modelByThread.get(event.threadId);
    const entry: CostEntry = {
      id: randomUUID(),
      ts: this.now(),
      botId: this.options.botFor(event.threadId),
      threadId: event.threadId,
      costUsd: event.cost,
      ...(model ? { model } : {}),
      source: this.options.classify(event.threadId),
    };
    this.entries.unshift(entry);
    this.prune();
    this.save();
    this.options.emit?.({ kind: "cost", summary: this.summary() });
  }

  /** Collapse overflow rows (oldest first) into their day's rollup. */
  private prune() {
    while (this.entries.length > this.maxEntries) {
      const entry = this.entries.pop()!;
      const day = dayKey(entry.ts);
      let rollup = this.rollups.find((r) => r.day === day);
      if (!rollup) {
        rollup = { day, turns: 0, costUsd: 0, byBot: {}, bySource: {} };
        this.rollups.push(rollup);
        this.rollups.sort((a, b) => (a.day < b.day ? -1 : 1));
        if (this.rollups.length > MAX_ROLLUP_DAYS) this.rollups.shift();
      }
      rollup.turns += 1;
      rollup.costUsd += entry.costUsd;
      if (entry.botId) rollup.byBot[entry.botId] = (rollup.byBot[entry.botId] ?? 0) + entry.costUsd;
      rollup.bySource[entry.source] = (rollup.bySource[entry.source] ?? 0) + entry.costUsd;
    }
  }

  summary(): CostSummary {
    const now = this.now();
    const today = dayKey(now);
    const weekAgo = now - 7 * 24 * 60 * 60_000;
    const weekAgoDay = dayKey(weekAgo);
    const totals = { todayUsd: 0, last7DaysUsd: 0, allTimeUsd: 0, turns: 0 };
    const byBot = new Map<string, { costUsd: number; turns: number }>();
    const bySource: Record<CostSource, number> = { chat: 0, goal: 0, pipeline: 0, routine: 0 };
    const byDay = new Map<string, { costUsd: number; turns: number }>();

    const addDay = (day: string, costUsd: number, turns: number) => {
      const slot = byDay.get(day) ?? { costUsd: 0, turns: 0 };
      slot.costUsd += costUsd;
      slot.turns += turns;
      byDay.set(day, slot);
    };
    for (const entry of this.entries) {
      totals.allTimeUsd += entry.costUsd;
      totals.turns += 1;
      const day = dayKey(entry.ts);
      if (day === today) totals.todayUsd += entry.costUsd;
      if (entry.ts >= weekAgo) totals.last7DaysUsd += entry.costUsd;
      if (entry.botId) {
        const slot = byBot.get(entry.botId) ?? { costUsd: 0, turns: 0 };
        slot.costUsd += entry.costUsd;
        slot.turns += 1;
        byBot.set(entry.botId, slot);
      }
      bySource[entry.source] += entry.costUsd;
      addDay(day, entry.costUsd, 1);
    }
    for (const rollup of this.rollups) {
      totals.allTimeUsd += rollup.costUsd;
      totals.turns += rollup.turns;
      if (rollup.day === today) totals.todayUsd += rollup.costUsd;
      if (rollup.day >= weekAgoDay) totals.last7DaysUsd += rollup.costUsd;
      for (const [botId, costUsd] of Object.entries(rollup.byBot)) {
        const slot = byBot.get(botId) ?? { costUsd: 0, turns: 0 };
        slot.costUsd += costUsd;
        byBot.set(botId, slot);
      }
      for (const [source, costUsd] of Object.entries(rollup.bySource)) {
        bySource[source as CostSource] += costUsd ?? 0;
      }
      addDay(rollup.day, rollup.costUsd, rollup.turns);
    }
    return {
      totals,
      byBot: [...byBot.entries()]
        .map(([botId, slot]) => ({ botId, ...slot }))
        .sort((a, b) => b.costUsd - a.costUsd),
      bySource,
      byDay: [...byDay.entries()]
        .map(([day, slot]) => ({ day, ...slot }))
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .slice(0, BY_DAY_LIMIT),
      recent: this.entries.slice(0, RECENT_LIMIT).map((entry) => ({ ...entry })),
    };
  }

  /** P11 export/import (see server/org-export.ts). */
  exportState(): { entries: CostEntry[]; rollups: CostRollup[] } {
    return { entries: this.entries.map((e) => ({ ...e })), rollups: this.rollups.map((r) => ({ ...r })) };
  }

  /** P11 import — only into an empty ledger. */
  importState(data: { entries?: unknown; rollups?: unknown }) {
    if (this.entries.length || this.rollups.length) throw new Error("cost ledger is not empty");
    this.entries = Array.isArray(data.entries) ? (data.entries as CostEntry[]) : [];
    this.rollups = Array.isArray(data.rollups) ? (data.rollups as CostRollup[]) : [];
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, entries: this.entries, rollups: this.rollups } satisfies CostFile, null, 2),
    );
  }
}
