import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

/** Hard stops checked between sessions — a breach halts the goal, never the
 * in-flight turn. Spend uses the provider-reported per-turn cost when a
 * driver supplies one; drivers that report no cost fall back to the session
 * cap as the effective spend proxy. */
export interface GoalGuardrails {
  maxSessions: number;
  spendCapUsd: number;
  wallClockMinutes: number;
  /** consecutive sessions without a criterion completing */
  stuckThreshold: number;
}

export interface GoalCriterion {
  id: string;
  text: string;
  done: boolean;
}

export type GoalStatus = "running" | "paused" | "done" | "halted" | "cancelled";

export interface Goal {
  id: string;
  name: string;
  botId: string;
  /** the detached task thread all of this goal's sessions run in */
  threadId?: string;
  criteria: GoalCriterion[];
  guardrails: GoalGuardrails;
  status: GoalStatus;
  haltReason?: string;
  sessions: number;
  spentUsd: number;
  /** sessions in a row without progress */
  stuck: number;
  /** last assistant reply, kept so the UI can show what the bot said */
  lastReply?: string;
  startedAt: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalInput {
  name: string;
  botId: string;
  criteria: string[];
  guardrails?: Partial<GoalGuardrails>;
}

interface GoalFile {
  version: 1;
  goals: Goal[];
}

export interface GoalManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string) => Promise<void>;
  /** P9 audit hook: called when a guardrail (or missing bot) halts a goal */
  onHalted?: (goal: Goal) => void;
}

const DEFAULT_GUARDRAILS: GoalGuardrails = {
  maxSessions: 10,
  spendCapUsd: 5,
  wallClockMinutes: 120,
  stuckThreshold: 3,
};
const MAX_GOALS = 500;
const TICK_MS = 5_000;

function cleanNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanGuardrails(input: Partial<GoalGuardrails> | undefined): GoalGuardrails {
  return {
    maxSessions: Math.round(cleanNumber(input?.maxSessions, DEFAULT_GUARDRAILS.maxSessions, 1, 100)),
    spendCapUsd: cleanNumber(input?.spendCapUsd, DEFAULT_GUARDRAILS.spendCapUsd, 0.01, 1_000),
    wallClockMinutes: cleanNumber(input?.wallClockMinutes, DEFAULT_GUARDRAILS.wallClockMinutes, 1, 7 * 24 * 60),
    stuckThreshold: Math.round(cleanNumber(input?.stuckThreshold, DEFAULT_GUARDRAILS.stuckThreshold, 1, 20)),
  };
}

/** The convention the session prompt asks for — a reply line starting with
 * DONE marks the current criterion satisfied. */
export function replyMarksDone(reply: string | undefined): boolean {
  return Boolean(reply && /^\s*done\b/im.test(reply));
}

export function sessionPrompt(goal: Goal, criterion: GoalCriterion): string {
  const checklist = goal.criteria
    .map((c) => `${c.done ? "[x]" : c.id === criterion.id ? "[>]" : "[ ]"} ${c.text}`)
    .join("\n");
  return [
    `You are working toward the goal "${goal.name}". Success criteria:`,
    checklist,
    "",
    `Work on the criterion marked [>] now: ${criterion.text}`,
    "When you finish, end your reply with a line starting with DONE if that criterion is now satisfied, or BLOCKED plus what you need.",
  ].join("\n");
}

/** Drives an existing bot toward a goal: one detached task, one turn per
 * session, criteria checked off when the bot self-reports DONE, guardrails
 * enforced between sessions. Mirrors the RoutineManager pattern. */
export class GoalManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: GoalManagerOptions;
  private goals: Goal[] = [];
  /** threadId → goalId for sessions awaiting turn.completed */
  private readonly inFlight = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: GoalManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "goals.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<GoalFile>;
      this.goals = Array.isArray(disk.goals) ? disk.goals : [];
    } catch {
      this.goals = [];
    }
    // A restart loses any in-flight turn; running goals simply start their
    // next session on the first tick (the wall clock keeps counting).
  }

  list(): Goal[] {
    return this.goals.map((goal) => this.copy(goal));
  }

  get(id: string): Goal | null {
    const goal = this.goals.find((candidate) => candidate.id === id);
    return goal ? this.copy(goal) : null;
  }

  create(input: GoalInput): Goal {
    const name = String(input.name ?? "").trim().slice(0, 120);
    const botId = String(input.botId ?? "").trim();
    const criteria = (Array.isArray(input.criteria) ? input.criteria : [])
      .map((text) => String(text ?? "").trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 20)
      .map((text) => ({ id: randomUUID().slice(0, 8), text, done: false }));
    if (!name) throw new Error("Give the goal a name");
    if (!botId) throw new Error("Choose a bot");
    if (criteria.length === 0) throw new Error("Add at least one success criterion");
    if (this.options.botState(botId) === "missing") throw new Error("That bot no longer exists");
    const at = this.now();
    const goal: Goal = {
      id: randomUUID(),
      name,
      botId,
      criteria,
      guardrails: cleanGuardrails(input.guardrails),
      status: "running",
      sessions: 0,
      spentUsd: 0,
      stuck: 0,
      startedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    this.goals.unshift(goal);
    if (this.goals.length > MAX_GOALS) this.goals.length = MAX_GOALS;
    this.save();
    this.emitGoal(goal);
    queueMicrotask(() => void this.tick());
    return this.copy(goal);
  }

  pause(id: string): Goal | null {
    const goal = this.goals.find((candidate) => candidate.id === id);
    if (!goal || goal.status !== "running") return null;
    // an in-flight session finishes and is recorded; no NEXT session starts
    goal.status = "paused";
    goal.updatedAt = this.now();
    this.save();
    this.emitGoal(goal);
    return this.copy(goal);
  }

  resume(id: string): Goal | null {
    const goal = this.goals.find((candidate) => candidate.id === id);
    if (!goal || goal.status !== "paused") return null;
    goal.status = "running";
    goal.updatedAt = this.now();
    this.save();
    this.emitGoal(goal);
    queueMicrotask(() => void this.tick());
    return this.copy(goal);
  }

  async cancel(id: string): Promise<Goal | null> {
    const goal = this.goals.find((candidate) => candidate.id === id);
    if (!goal || !["running", "paused"].includes(goal.status)) return null;
    goal.status = "cancelled";
    goal.finishedAt = this.now();
    goal.updatedAt = goal.finishedAt;
    this.save();
    this.emitGoal(goal);
    if (goal.threadId && this.inFlight.get(goal.threadId) === goal.id) {
      this.inFlight.delete(goal.threadId);
      await this.options.interruptTurn?.(goal.botId, goal.threadId).catch(() => {});
    }
    return this.copy(goal);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const goal of this.goals) {
        if (goal.status !== "running") continue;
        if (goal.threadId && this.inFlight.has(goal.threadId)) continue;
        const breach = this.guardrailBreach(goal);
        if (breach) {
          this.finish(goal, "halted", breach);
          continue;
        }
        const open = goal.criteria.find((criterion) => !criterion.done);
        if (!open) {
          this.finish(goal, "done");
          continue;
        }
        const state = this.options.botState(goal.botId);
        if (state === "busy") continue; // retry next tick
        if (state === "missing") {
          this.finish(goal, "halted", "the assigned bot no longer exists");
          continue;
        }
        if (!goal.threadId) {
          const task = this.options.createTask(goal.botId, goal.name);
          if (!task) {
            this.finish(goal, "halted", "could not create a task for this goal");
            continue;
          }
          goal.threadId = task.threadId;
        }
        const threadId = goal.threadId;
        goal.sessions += 1;
        goal.lastReply = undefined;
        goal.updatedAt = this.now();
        this.inFlight.set(threadId, goal.id);
        this.save();
        this.emitGoal(goal);
        try {
          await this.options.startTurn(goal.botId, threadId, sessionPrompt(goal, open), (message) =>
            this.failSession(threadId, message),
          );
        } catch (error) {
          this.failSession(threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent) {
    const goalId = this.inFlight.get(event.threadId);
    const goal = goalId ? this.goals.find((candidate) => candidate.id === goalId) : undefined;
    if (!goal) return;
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      goal.lastReply = event.text.trim().slice(0, 2_000);
      goal.updatedAt = this.now();
      this.save();
      this.emitGoal(goal);
      return;
    }
    if (event.type !== "turn.completed") return;
    this.inFlight.delete(event.threadId);
    goal.spentUsd += typeof event.cost === "number" ? event.cost : 0;
    const open = goal.criteria.find((criterion) => !criterion.done);
    if (event.ok && open && replyMarksDone(goal.lastReply)) {
      open.done = true;
      goal.stuck = 0;
    } else {
      goal.stuck += 1;
    }
    goal.updatedAt = this.now();
    this.save();
    this.emitGoal(goal);
    queueMicrotask(() => void this.tick());
  }

  /** A session that never reached the provider (dispatch error) still counts
   * as a stuck session — the guardrails, not a retry loop, decide when to stop. */
  failSession(threadId: string, message: string) {
    const goalId = this.inFlight.get(threadId);
    const goal = goalId ? this.goals.find((candidate) => candidate.id === goalId) : undefined;
    if (!goal) return;
    this.inFlight.delete(threadId);
    goal.stuck += 1;
    goal.lastReply = `error: ${message.slice(0, 500)}`;
    goal.updatedAt = this.now();
    this.save();
    this.emitGoal(goal);
    queueMicrotask(() => void this.tick());
  }

  private guardrailBreach(goal: Goal): string | null {
    const g = goal.guardrails;
    if (goal.sessions >= g.maxSessions) return `session cap reached (${g.maxSessions})`;
    if (goal.spentUsd >= g.spendCapUsd) return `spend cap reached ($${g.spendCapUsd})`;
    if (this.now() - goal.startedAt >= g.wallClockMinutes * 60_000)
      return `wall clock exceeded (${g.wallClockMinutes}m)`;
    if (goal.stuck >= g.stuckThreshold) return `stuck: ${goal.stuck} sessions without progress`;
    return null;
  }

  private finish(goal: Goal, status: "done" | "halted", haltReason?: string) {
    goal.status = status;
    goal.haltReason = haltReason;
    goal.finishedAt = this.now();
    goal.updatedAt = goal.finishedAt;
    this.save();
    this.emitGoal(goal);
    if (status === "halted") this.options.onHalted?.(this.copy(goal));
  }

  private copy(goal: Goal): Goal {
    return {
      ...goal,
      criteria: goal.criteria.map((criterion) => ({ ...criterion })),
      guardrails: { ...goal.guardrails },
    };
  }

  private emitGoal(goal: Goal) {
    this.options.emit?.({ kind: "goal", goal: this.copy(goal) });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, goals: this.goals } satisfies GoalFile, null, 2));
  }
}
