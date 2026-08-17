// Pure board derivation: kanban columns computed from state the client
// already holds (bot tasks, goals, inbox, routine runs). No server state.

import type { Goal } from "@/lib/goals";
import type { InboxItem, InboxQuestion } from "@/lib/inbox";
import type { RoutineRun } from "@/lib/routines";

/** The slice of a Bot the board needs (structural, so tests stay plain). */
export interface BoardBot {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string; title: string; createdAt: number }>;
  name: string;
  busy?: boolean;
  hidden?: boolean;
}

export type BoardColumnKey = "queued" | "inProgress" | "waiting" | "done" | "halted";

export const BOARD_COLUMNS: Array<{ key: BoardColumnKey; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "inProgress", label: "In progress" },
  { key: "waiting", label: "Waiting on human" },
  { key: "done", label: "Done" },
  { key: "halted", label: "Halted" },
];

export type BoardNav =
  | { view: "chat"; botId: string; threadId: string }
  | { view: "goals" }
  | { view: "inbox" }
  | { view: "routines" };

export interface BoardCard {
  /** unique across the whole board (kind-prefixed) */
  id: string;
  kind: "task" | "goal" | "question" | "note" | "routine";
  title: string;
  subtitle: string;
  botId?: string;
  nav: BoardNav;
  /** recency used for ordering within a column, newest first */
  ts: number;
}

export interface BoardInput {
  bots: BoardBot[];
  goals: Goal[];
  inboxItems: InboxItem[];
  inboxQuestions: InboxQuestion[];
  routineRuns: RoutineRun[];
}

const GOAL_COLUMN: Record<Goal["status"], BoardColumnKey> = {
  running: "inProgress",
  paused: "queued",
  done: "done",
  halted: "waiting", // a guardrail stop needs a human decision
  cancelled: "halted",
};

const RUN_COLUMN: Record<RoutineRun["status"], BoardColumnKey> = {
  queued: "queued",
  running: "inProgress",
  waiting: "inProgress",
  completed: "done",
  failed: "halted",
  cancelled: "halted",
  missed: "halted",
};

/** Compute the whole board. Honest mapping only: an idle chat task has no
 * run state, so tasks appear solely while their bot is actually working. */
export function computeBoard(input: BoardInput): Record<BoardColumnKey, BoardCard[]> {
  const columns: Record<BoardColumnKey, BoardCard[]> = {
    queued: [],
    inProgress: [],
    waiting: [],
    done: [],
    halted: [],
  };
  const add = (column: BoardColumnKey, card: BoardCard) => columns[column].push(card);
  const botName = (botId: string) => input.bots.find((b) => b.id === botId)?.name ?? "Unknown bot";

  for (const bot of input.bots) {
    if (bot.hidden || !bot.busy) continue;
    const active = bot.tasks?.find((t) => t.threadId === bot.threadId);
    add("inProgress", {
      id: `task:${bot.id}:${bot.threadId}`,
      kind: "task",
      title: active?.title ?? "New task",
      subtitle: bot.name,
      botId: bot.id,
      nav: { view: "chat", botId: bot.id, threadId: bot.threadId },
      ts: active?.createdAt ?? 0,
    });
  }

  for (const goal of input.goals) {
    const done = goal.criteria.filter((c) => c.done).length;
    add(GOAL_COLUMN[goal.status], {
      id: `goal:${goal.id}`,
      kind: "goal",
      title: goal.name,
      subtitle:
        goal.status === "halted" && goal.haltReason
          ? `${botName(goal.botId)} · ${goal.haltReason}`
          : `${botName(goal.botId)} · ${done}/${goal.criteria.length} criteria`,
      botId: goal.botId,
      nav: { view: "goals" },
      ts: goal.updatedAt,
    });
  }

  for (const question of input.inboxQuestions) {
    if (question.status !== "pending") continue;
    add("waiting", {
      id: `question:${question.id}`,
      kind: "question",
      title: question.prompt,
      subtitle: `${botName(question.botId)} · question`,
      botId: question.botId,
      nav: { view: "inbox" },
      ts: question.ts,
    });
  }

  for (const item of input.inboxItems) {
    if (item.status !== "open") continue;
    add("waiting", {
      id: `note:${item.id}`,
      kind: "note",
      title: item.text,
      subtitle: `${botName(item.botId)} · inbox`,
      botId: item.botId,
      nav: { view: "inbox" },
      ts: item.ts,
    });
  }

  for (const run of input.routineRuns) {
    add(RUN_COLUMN[run.status], {
      id: `routine:${run.id}`,
      kind: "routine",
      title: run.routineName,
      subtitle:
        run.status === "missed"
          ? `${botName(run.botId)} · missed`
          : run.error
            ? `${botName(run.botId)} · ${run.error}`
            : `${botName(run.botId)} · routine`,
      botId: run.botId,
      nav: { view: "routines" },
      ts: run.startedAt ?? run.scheduledFor,
    });
  }

  for (const key of Object.keys(columns) as BoardColumnKey[]) {
    columns[key].sort((a, b) => b.ts - a.ts);
  }
  return columns;
}
