// Client mirror of the server's goal records (server/goals.ts).

export interface GoalGuardrails {
  maxSessions: number;
  spendCapUsd: number;
  wallClockMinutes: number;
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
  threadId?: string;
  criteria: GoalCriterion[];
  guardrails: GoalGuardrails;
  status: GoalStatus;
  haltReason?: string;
  sessions: number;
  spentUsd: number;
  stuck: number;
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
