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

export type AgentRecord = {
  id: string;
  name: string;
  persona: string;
  driver: "mock" | "anthropic";
  modelPolicy: ModelPolicy;
  allowTools: string[];
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
  | AuditNoteBody;

export type AtriumEvent = {
  id: string;
  org: string;
  kind: EventKindValue;
  channelId?: string;
  authorId: string;
  ts: number;
  body: EventBody;
};
