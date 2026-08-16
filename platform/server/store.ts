// Atrium event store + projections (T2).
import fs from "node:fs";
import path from "node:path";
import type {
  AgentRecord,
  Approval,
  AtriumEvent,
  Channel,
  MemoryEntry,
  User,
} from "../shared/contracts.ts";
import { EventKind } from "../shared/contracts.ts";

const DEFAULT_DATA_DIR = path.join(import.meta.dirname, "..", ".data");

export function dataDir(): string {
  return process.env["ATRIUM_DATA_DIR"] ?? DEFAULT_DATA_DIR;
}

/** Append-only NDJSON log, one file per org. */
export class EventStore {
  readonly dir: string;

  constructor(dir: string = dataDir()) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(org: string): string {
    if (!/^[a-z0-9_-]+$/i.test(org)) throw new Error(`invalid org: ${org}`);
    return path.join(this.dir, `${org}.ndjson`);
  }

  /** Atomic append of one JSON line. */
  append(event: AtriumEvent): void {
    fs.appendFileSync(this.fileFor(event.org), JSON.stringify(event) + "\n", "utf8");
  }

  /** Replay all events for an org in append order. */
  *replay(org: string): Generator<AtriumEvent> {
    const file = this.fileFor(org);
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      yield JSON.parse(line) as AtriumEvent;
    }
  }
}

export type TranscriptItem = {
  eventId: string;
  authorId: string;
  ts: number;
  /** "message" for kind-1, "chip" for agent turn start/complete markers. */
  type: "message" | "chip";
  text: string;
};

/** In-memory projections, rebuilt fully from the log on boot. */
export class Projections {
  channels = new Map<string, Channel>();
  users = new Map<string, User>();
  agents = new Map<string, AgentRecord>();
  transcripts = new Map<string, TranscriptItem[]>();
  memory = new Map<string, MemoryEntry>();
  approvals = new Map<string, Approval>();

  rebuild(store: EventStore, org: string): void {
    this.channels.clear();
    this.users.clear();
    this.agents.clear();
    this.transcripts.clear();
    this.memory.clear();
    this.approvals.clear();
    for (const ev of store.replay(org)) this.fold(ev);
  }

  fold(ev: AtriumEvent): void {
    const body = ev.body;
    switch (body.kind) {
      case EventKind.ChannelCreated:
        this.channels.set(body.channel.id, { ...body.channel, memberIds: [...body.channel.memberIds] });
        this.transcripts.set(body.channel.id, this.transcripts.get(body.channel.id) ?? []);
        break;
      case EventKind.MemberAdded: {
        if (body.user) this.users.set(body.user.id, body.user);
        if (body.agent) this.agents.set(body.agent.id, body.agent);
        if (ev.channelId) {
          const ch = this.channels.get(ev.channelId);
          if (ch && !ch.memberIds.includes(body.userId)) ch.memberIds.push(body.userId);
        }
        break;
      }
      case EventKind.Message:
        this.pushTranscript(ev, "message", body.text);
        break;
      case EventKind.AgentTurnStarted:
        this.pushTranscript(ev, "chip", `turn ${body.turnId} started`);
        break;
      case EventKind.AgentTurnCompleted:
        this.pushTranscript(ev, "chip", `turn ${body.turnId} completed`);
        this.pushTranscript(ev, "message", body.text);
        break;
      case EventKind.ApprovalRequested:
        this.approvals.set(body.approval.id, { ...body.approval });
        break;
      case EventKind.ApprovalResolved: {
        const ap = this.approvals.get(body.approvalId);
        if (ap) ap.status = body.status;
        break;
      }
      case EventKind.MemoryProposed: {
        const entry = { ...body.entry };
        this.memory.set(entry.id, entry);
        // Supersede-not-delete: the prior version stays, marked superseded.
        if (entry.supersedes) {
          const prev = this.memory.get(entry.supersedes);
          if (prev) prev.status = "superseded";
        }
        break;
      }
      case EventKind.MemoryAccepted: {
        const m = this.memory.get(body.entryId);
        if (m) m.trustTier = "human_confirmed";
        break;
      }
      case EventKind.MemoryRejected: {
        const m = this.memory.get(body.entryId);
        if (m) m.status = "retired";
        break;
      }
      default:
        break; // reactions, sandbox audit, notes: not projected yet (Wave 2+)
    }
  }

  private pushTranscript(ev: AtriumEvent, type: TranscriptItem["type"], text: string): void {
    if (!ev.channelId) return;
    const list = this.transcripts.get(ev.channelId) ?? [];
    list.push({ eventId: ev.id, authorId: ev.authorId, ts: ev.ts, type, text });
    this.transcripts.set(ev.channelId, list);
  }

  /** Walk a memory entry's version chain (newest first). */
  memoryChain(entryId: string): MemoryEntry[] {
    const chain: MemoryEntry[] = [];
    let cur = this.memory.get(entryId);
    while (cur) {
      chain.push(cur);
      cur = cur.supersedes ? this.memory.get(cur.supersedes) : undefined;
    }
    return chain;
  }
}
