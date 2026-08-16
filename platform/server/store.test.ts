import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventStore, Projections } from "./store.ts";
import { EventKind } from "../shared/contracts.ts";
import type { AtriumEvent, Channel, MemoryEntry } from "../shared/contracts.ts";

const tmpDirs: string[] = [];
function freshStore(): EventStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-test-"));
  tmpDirs.push(dir);
  return new EventStore(dir);
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function ev(body: AtriumEvent["body"], channelId?: string, authorId = "u1"): AtriumEvent {
  const e: AtriumEvent = { id: crypto.randomUUID(), org: "acme", kind: body.kind, authorId, ts: Date.now(), body };
  if (channelId) e.channelId = channelId;
  return e;
}

function memEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: crypto.randomUUID(),
    scope: "org",
    kind: "fact",
    content: "the sky is blue",
    provenance: { author: "u1", sessionRef: "s1" },
    trustTier: "agent_proposed",
    status: "active",
    ts: Date.now(),
    ...overrides,
  };
}

describe("EventStore + Projections", () => {
  it("append → replay → projection equivalence", () => {
    const store = freshStore();
    const chan: Channel = { id: "c1", name: "general", space: "hq", memberIds: ["u1"] };
    const events = [
      ev({ kind: EventKind.MemberAdded, userId: "u1", user: { id: "u1", name: "yosri", kind: "human" } }),
      ev({ kind: EventKind.ChannelCreated, channel: chan }, "c1"),
      ev({ kind: EventKind.Message, text: "hello" }, "c1"),
      ev({ kind: EventKind.Message, text: "world" }, "c1"),
    ];
    const live = new Projections();
    for (const e of events) {
      store.append(e);
      live.fold(e);
    }
    // Rebuilt-from-log projections must equal live-folded projections.
    const rebuilt = new Projections();
    rebuilt.rebuild(store, "acme");
    expect([...store.replay("acme")]).toEqual(events);
    expect(rebuilt.channels).toEqual(live.channels);
    expect(rebuilt.users).toEqual(live.users);
    expect(rebuilt.transcripts).toEqual(live.transcripts);
    expect(rebuilt.transcripts.get("c1")!.map((t) => t.text)).toEqual(["hello", "world"]);
  });

  it("memory supersede chain is preserved (supersede-not-delete)", () => {
    const store = freshStore();
    const v1 = memEntry({ content: "v1" });
    const v2 = memEntry({ content: "v2", supersedes: v1.id });
    const v3 = memEntry({ content: "v3", supersedes: v2.id });
    for (const entry of [v1, v2, v3]) store.append(ev({ kind: EventKind.MemoryProposed, entry }));
    store.append(ev({ kind: EventKind.MemoryAccepted, entryId: v3.id, by: "u1" }));
    const p = new Projections();
    p.rebuild(store, "acme");
    expect(p.memory.size).toBe(3); // nothing deleted
    expect(p.memory.get(v1.id)!.status).toBe("superseded");
    expect(p.memory.get(v2.id)!.status).toBe("superseded");
    expect(p.memory.get(v3.id)!.status).toBe("active");
    expect(p.memory.get(v3.id)!.trustTier).toBe("human_confirmed");
    expect(p.memoryChain(v3.id).map((m) => m.content)).toEqual(["v3", "v2", "v1"]);
  });
});
