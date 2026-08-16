// Atrium shared contracts (T1). Erasable-syntax-only: const objects, no enums.

/** Event kinds — integer-extensible, per DESIGN.md "Event kinds". */
export const EventKind = {
  Message: 1,
  Reaction: 2,
  ChannelCreated: 10,
  MemberAdded: 11,
  AgentTurnStarted: 20,
  /** Ephemeral: fan-out only, never appended to the log. */
  AgentStreamDelta: 21,
  AgentTurnCompleted: 22,
  ApprovalRequested: 30,
  ApprovalResolved: 31,
  MemoryProposed: 40,
  MemoryAccepted: 41,
  MemoryRejected: 42,
  SandboxExec: 50,
  AuditNote: 60,
  /** Wave 5 (T18): a data_query tool call executed a query plan. */
  PlanExecuted: 61,
  /** Wave 5 (T17): routines. */
  RoutineCreated: 70,
  RoutineRunStarted: 71,
  RoutineRunCompleted: 72,
  /** Wave 6 (W6-A): inbox — the only agent→human attention channel. */
  InboxPosted: 80,
  InboxReplied: 81,
  QuestionAsked: 82,
  QuestionAnswered: 83,
  /** Wave 6 (W6-B): goals — definition-of-done loops with guardrails. */
  GoalCreated: 90,
  GoalSessionStarted: 91,
  GoalSessionCompleted: 92,
  GoalCriterionChecked: 93,
  GoalCompleted: 94,
  GoalHalted: 95,
  /** Wave 6 (W6-C): pipeline templates with approval gates. */
  TemplateCreated: 100,
  PipelineStarted: 101,
  PipelineStepStarted: 102,
  PipelineStepCompleted: 103,
  PipelineCompleted: 104,
  /** Wave 6 (W6-D): policy-gated files + egress audit. */
  FileWritten: 110,
  EgressDenied: 111,
  /** Wave 6 (W6-E): per-turn cost estimate. */
  TurnCostRecorded: 120,
} as const;

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind];

// ---------- Records ----------

export type UserKind = "human" | "agent";

export type User = {
  id: string;
  name: string;
  kind: UserKind;
};

export type ModelPolicy = {
  model: string;
  effort: string;
  maxTokens: number;
};

/** W6-D: per-agent environment — egress allowlist enforced server-side on http_fetch. */
export type AgentEnvironment = {
  networkAllowlist: string[];
};

export type AgentRecord = {
  id: string;
  name: string;
  persona: string;
  driver: "mock" | "anthropic";
  modelPolicy: ModelPolicy;
  allowTools: string[];
  environment?: AgentEnvironment;
};

export type Channel = {
  id: string;
  name: string;
  space: string;
  memberIds: string[];
};

export type MemoryScope = "org" | "space" | "personal";
export type MemoryKind = "fact" | "preference" | "procedure" | "episode" | "glossary";
export type TrustTier = "quarantined" | "agent_proposed" | "human_confirmed" | "org_ratified";
export type MemoryStatus = "active" | "superseded" | "retired";

export type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  provenance: { author: string; sessionRef: string };
  trustTier: TrustTier;
  status: MemoryStatus;
  supersedes?: string;
  ts: number;
};

/** Wave 5 (T17): a scheduled or manually-triggered prompt aimed at one agent in one channel. */
export type RoutineSchedule = { kind: "interval"; minutes: number } | { kind: "manual" };

export type RoutineRecord = {
  id: string;
  name: string;
  agentId: string;
  channelId: string;
  prompt: string;
  schedule: RoutineSchedule;
  lastRunAt?: number;
};

/** Wave 5 (T18): result rows from the deterministic data engine. */
export type DataRow = Record<string, string | number>;

// ---------- Wave 6 records ----------

/** W6-A: an inbox item — an agent's status message or blocking question to a human. */
export type InboxItem = {
  id: string;
  agentId: string;
  channelId?: string;
  text: string;
  ts: number;
  status: "open" | "replied";
  reply?: string;
};

/** W6-A: a blocking multiple-choice (or free-text) question from an agent. */
export type QuestionRecord = {
  id: string;
  agentId: string;
  channelId: string;
  prompt: string;
  /** Empty array = free-text question. */
  options: string[];
  status: "pending" | "answered";
  answer?: string;
};

/** W6-B: guardrails — every limit is a hard stop, never advisory. */
export type GoalGuardrails = {
  maxSessions: number;
  spendCapUsd: number;
  wallClockMinutes: number;
  /** Consecutive sessions with no criterion progress before the loop halts. */
  stuckThreshold: number;
};

export type GoalCriterion = { id: string; text: string; done: boolean };

export type GoalStatus = "running" | "done" | "halted";

export type GoalRecord = {
  id: string;
  name: string;
  spec: string;
  criteria: GoalCriterion[];
  guardrails: GoalGuardrails;
  status: GoalStatus;
  haltReason?: string;
  sessions: number;
  spentUsd: number;
  startedAt: number;
  agentId: string;
  channelId: string;
};

/** W6-C: one step of a pipeline template. */
export type TemplateStep = {
  title: string;
  agentId: string;
  prompt: string;
  /** Approval gate: a human must advance the run past this step. */
  requiresApproval: boolean;
};

export type TemplateRecord = {
  id: string;
  name: string;
  steps: TemplateStep[];
};

export type PipelineStepStatus = "pending" | "running" | "awaiting_approval" | "done";

export type PipelineRun = {
  id: string;
  templateId: string;
  name: string;
  channelId: string;
  input: string;
  stepIndex: number;
  stepStates: PipelineStepStatus[];
  status: "running" | "done";
};

/** W6-E: cost estimate for one agent turn (derived, deterministic). */
export type TurnCost = {
  turnId: string;
  agentId: string;
  estTokens: number;
  estUsd: number;
};

export type ApprovalStatus = "pending" | "approved" | "denied";

export type Approval = {
  id: string;
  agentId: string;
  channelId: string;
  tool: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
};

// ---------- Event bodies (kind-specific union) ----------

export type MessageBody = { kind: typeof EventKind.Message; text: string };
export type ReactionBody = { kind: typeof EventKind.Reaction; targetEventId: string; emoji: string };
export type ChannelCreatedBody = { kind: typeof EventKind.ChannelCreated; channel: Channel };
export type MemberAddedBody = { kind: typeof EventKind.MemberAdded; userId: string; user?: User; agent?: AgentRecord };
export type AgentTurnStartedBody = { kind: typeof EventKind.AgentTurnStarted; turnId: string };
export type AgentStreamDeltaBody = { kind: typeof EventKind.AgentStreamDelta; turnId: string; delta: string };
export type AgentTurnCompletedBody = { kind: typeof EventKind.AgentTurnCompleted; turnId: string; text: string };
export type ApprovalRequestedBody = { kind: typeof EventKind.ApprovalRequested; approval: Approval };
export type ApprovalResolvedBody = { kind: typeof EventKind.ApprovalResolved; approvalId: string; status: "approved" | "denied"; by: string };
export type MemoryProposedBody = { kind: typeof EventKind.MemoryProposed; entry: MemoryEntry };
export type MemoryAcceptedBody = { kind: typeof EventKind.MemoryAccepted; entryId: string; by: string };
export type MemoryRejectedBody = { kind: typeof EventKind.MemoryRejected; entryId: string; by: string };
export type SandboxExecBody = { kind: typeof EventKind.SandboxExec; agentId: string; argv: string[]; exitCode: number; stdout: string };
export type AuditNoteBody = { kind: typeof EventKind.AuditNote; note: string };
export type PlanExecutedBody = {
  kind: typeof EventKind.PlanExecuted;
  agentId: string;
  plan: string[];
  sql_like: string;
  resultPreview: DataRow[];
};
export type RoutineCreatedBody = { kind: typeof EventKind.RoutineCreated; routine: RoutineRecord };
export type RoutineRunStartedBody = { kind: typeof EventKind.RoutineRunStarted; routineId: string };
export type RoutineRunCompletedBody = { kind: typeof EventKind.RoutineRunCompleted; routineId: string; ranAt: number };
export type InboxPostedBody = { kind: typeof EventKind.InboxPosted; item: InboxItem };
export type InboxRepliedBody = { kind: typeof EventKind.InboxReplied; itemId: string; reply: string; by: string };
export type QuestionAskedBody = { kind: typeof EventKind.QuestionAsked; question: QuestionRecord };
export type QuestionAnsweredBody = { kind: typeof EventKind.QuestionAnswered; questionId: string; answer: string; by: string };
export type GoalCreatedBody = { kind: typeof EventKind.GoalCreated; goal: GoalRecord };
export type GoalSessionStartedBody = { kind: typeof EventKind.GoalSessionStarted; goalId: string; session: number };
export type GoalSessionCompletedBody = { kind: typeof EventKind.GoalSessionCompleted; goalId: string; session: number; spentUsd: number };
export type GoalCriterionCheckedBody = { kind: typeof EventKind.GoalCriterionChecked; goalId: string; criterionId: string };
export type GoalCompletedBody = { kind: typeof EventKind.GoalCompleted; goalId: string };
export type GoalHaltedBody = { kind: typeof EventKind.GoalHalted; goalId: string; reason: string };
export type TemplateCreatedBody = { kind: typeof EventKind.TemplateCreated; template: TemplateRecord };
export type PipelineStartedBody = { kind: typeof EventKind.PipelineStarted; run: PipelineRun };
export type PipelineStepStartedBody = { kind: typeof EventKind.PipelineStepStarted; runId: string; stepIndex: number };
export type PipelineStepCompletedBody = {
  kind: typeof EventKind.PipelineStepCompleted;
  runId: string;
  stepIndex: number;
  /** Whether the run now waits on a human approval gate. */
  gated: boolean;
};
export type PipelineCompletedBody = { kind: typeof EventKind.PipelineCompleted; runId: string };
export type FileWrittenBody = { kind: typeof EventKind.FileWritten; agentId: string; name: string; bytes: number };
export type EgressDeniedBody = { kind: typeof EventKind.EgressDenied; agentId: string; url: string };
export type TurnCostRecordedBody = { kind: typeof EventKind.TurnCostRecorded; cost: TurnCost };

export type EventBody =
  | MessageBody
  | ReactionBody
  | ChannelCreatedBody
  | MemberAddedBody
  | AgentTurnStartedBody
  | AgentStreamDeltaBody
  | AgentTurnCompletedBody
  | ApprovalRequestedBody
  | ApprovalResolvedBody
  | MemoryProposedBody
  | MemoryAcceptedBody
  | MemoryRejectedBody
  | SandboxExecBody
  | AuditNoteBody
  | PlanExecutedBody
  | RoutineCreatedBody
  | RoutineRunStartedBody
  | RoutineRunCompletedBody
  | InboxPostedBody
  | InboxRepliedBody
  | QuestionAskedBody
  | QuestionAnsweredBody
  | GoalCreatedBody
  | GoalSessionStartedBody
  | GoalSessionCompletedBody
  | GoalCriterionCheckedBody
  | GoalCompletedBody
  | GoalHaltedBody
  | TemplateCreatedBody
  | PipelineStartedBody
  | PipelineStepStartedBody
  | PipelineStepCompletedBody
  | PipelineCompletedBody
  | FileWrittenBody
  | EgressDeniedBody
  | TurnCostRecordedBody;

export type AtriumEvent = {
  id: string;
  org: string;
  kind: EventKindValue;
  channelId?: string;
  authorId: string;
  ts: number;
  body: EventBody;
};
