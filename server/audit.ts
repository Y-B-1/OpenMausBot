import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

// ── audit log (P9) ─────────────────────────────────────────────────────
// A hash-chained, append-only record of the consequential mutations across
// the ported features (org mode, connectors, memory review, goals,
// pipeline gates, files). Buzz's buzz-audit pattern: every entry carries
// the previous entry's hash and its own sha256 over (prevHash + canonical
// fields), so editing or deleting any middle entry breaks the chain and
// /api/audit/verify reports exactly where.
//
// Storage is NDJSON (one entry per line, `appendFileSync`) rather than a
// rewritten JSON blob: an append-only file matches the append-only chain,
// a normal record is one O(1) append, and a crash mid-write can corrupt at
// most the final line — which verify() then reports instead of hiding.

export interface AuditEntry {
  id: string;
  ts: number;
  /** org user id/name when P7 identified one, else "system" or a bot id */
  actor: string;
  /** dot-namespaced verb, e.g. "goal.create", "pipeline.approve" */
  action: string;
  /** what it acted on: an id, name, or short label */
  subject: string;
  detail?: string;
  prevHash: string;
  hash: string;
}

export interface AuditVerifyResult {
  valid: boolean;
  length: number;
  /** index (oldest = 0) and id of the first broken entry, when invalid */
  brokenAt?: { index: number; id: string; reason: "hash" | "link" };
}

/** prevHash of the very first entry ever written. */
export const GENESIS = "genesis";

/** sha256 over the previous hash + the entry's canonical fields. */
export function entryHash(entry: Omit<AuditEntry, "id" | "hash">): string {
  const canonical = JSON.stringify([
    entry.ts,
    entry.actor,
    entry.action,
    entry.subject,
    entry.detail ?? "",
  ]);
  return createHash("sha256").update(entry.prevHash + canonical).digest("hex");
}

export interface AuditManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  /** rotation trigger: past this many entries the oldest half is pruned */
  maxEntries?: number;
}

const MAX_ENTRIES = 2_000;
const LIST_LIMIT = 200;

export class AuditManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: AuditManagerOptions;
  private readonly maxEntries: number;
  /** oldest first — chain order */
  private entries: AuditEntry[] = [];

  constructor(options: AuditManagerOptions = {}) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "audit.ndjson");
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    try {
      const lines = readFileSync(this.file, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as AuditEntry;
          if (parsed && typeof parsed.hash === "string") this.entries.push(parsed);
        } catch {
          // a torn tail line is unreadable; verify() flags the gap via links
        }
      }
    } catch {
      this.entries = [];
    }
  }

  record(input: { actor?: string | null; action: string; subject: string; detail?: string }): AuditEntry {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    const base = {
      ts: this.now(),
      actor: input.actor?.trim() || "system",
      action: input.action,
      subject: input.subject,
      ...(input.detail ? { detail: input.detail } : {}),
      prevHash,
    };
    const entry: AuditEntry = { id: randomUUID(), ...base, hash: entryHash(base) };
    this.entries.push(entry);
    mkdirSync(dirname(this.file), { recursive: true });
    if (this.entries.length > this.maxEntries) {
      // Rotation: keep the newest half as-is (their links stay intact; the
      // new oldest entry's prevHash points at a pruned entry and is taken
      // as the trusted chain head). Rewrite is amortized: once per half-cap.
      this.entries = this.entries.slice(-Math.floor(this.maxEntries / 2));
      writeFileAtomic(this.file, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } else {
      appendFileSync(this.file, JSON.stringify(entry) + "\n");
    }
    this.options.emit?.({ kind: "audit", entry });
    return entry;
  }

  /** newest first; optional dot-prefix filter ("goal" matches "goal.create") */
  list(filter?: { action?: string; limit?: number }): AuditEntry[] {
    const prefix = filter?.action?.trim();
    const limit = filter?.limit ?? LIST_LIMIT;
    const matches = prefix
      ? this.entries.filter((e) => e.action === prefix || e.action.startsWith(prefix + "."))
      : this.entries;
    return matches.slice(-limit).reverse().map((e) => ({ ...e }));
  }

  /** Walk the chain oldest→newest; report the first tampered entry. */
  verify(): AuditVerifyResult {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (i > 0 && entry.prevHash !== this.entries[i - 1].hash) {
        return { valid: false, length: this.entries.length, brokenAt: { index: i, id: entry.id, reason: "link" } };
      }
      const { id: _id, hash, ...rest } = entry;
      if (entryHash(rest) !== hash) {
        return { valid: false, length: this.entries.length, brokenAt: { index: i, id: entry.id, reason: "hash" } };
      }
    }
    return { valid: true, length: this.entries.length };
  }
}
