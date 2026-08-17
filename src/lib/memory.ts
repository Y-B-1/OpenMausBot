// Client mirror of the server's memory records (server/memory.ts).

export type MemoryScope = "org" | "space" | "personal";
export type MemoryKind = "fact" | "preference" | "procedure" | "episode" | "glossary" | "lesson";
export type TrustTier = "quarantined" | "agent_proposed" | "human_confirmed" | "org_ratified";
export type MemoryStatus = "active" | "superseded" | "retired";
export type MemorySource = "agent" | "connector" | "human";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  provenance: { author: string; sessionRef: string };
  trustTier: TrustTier;
  status: MemoryStatus;
  source: MemorySource;
  supersedes?: string;
  /** P7 team wall: set = only that team's members (and admins) see it. */
  teamId?: string;
  ts: number;
  updatedAt: number;
}

export interface MemoryAddInput {
  scope?: MemoryScope;
  kind?: MemoryKind;
  content: string;
  author?: string;
  supersedes?: string;
}
