import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InboxManager } from "./inbox.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-inbox-"));
  dirs.push(dir);
  return join(dir, "inbox.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  const emitted: any[] = [];
  const options = {
    file: tempFile(),
    now: () => now,
    emit: (payload: unknown) => emitted.push(payload),
  };
  return { manager: new InboxManager(options), options, emitted, setNow: (v: number) => (now = v) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("InboxManager items", () => {
  it("posts an open item, emits it, and persists across a reload", () => {
    const h = harness();
    const item = h.manager.postItem({ botId: "maus-1", text: "Deploy finished." });
    expect(item).toMatchObject({ botId: "maus-1", text: "Deploy finished.", status: "open" });
    expect(h.emitted).toEqual([{ kind: "inbox.item", item }]);

    const reloaded = new InboxManager(h.options);
    expect(reloaded.listItems()).toEqual([item]);
    expect(reloaded.pendingCount()).toBe(1);
  });

  it("replying settles the item and clears it from the pending count", () => {
    const h = harness();
    const item = h.manager.postItem({ botId: "maus-1", text: "Need a look at the draft." });
    h.setNow(Date.now());
    const replied = h.manager.replyItem(item.id, "Looks good, ship it.");
    expect(replied).toMatchObject({ status: "replied", reply: "Looks good, ship it." });
    expect(replied!.repliedAt).toBeGreaterThan(item.ts);
    expect(h.manager.pendingCount()).toBe(0);
    expect(h.manager.replyItem("missing", "hello")).toBeNull();
  });

  it("rejects empty content instead of storing blanks", () => {
    const h = harness();
    expect(() => h.manager.postItem({ botId: "maus-1", text: "   " })).toThrow();
    expect(() => h.manager.postItem({ botId: "", text: "hi" })).toThrow();
    expect(h.manager.listItems()).toHaveLength(0);
  });
});

describe("InboxManager questions", () => {
  it("asks a multiple-choice question and settles it on answer", () => {
    const h = harness();
    const q = h.manager.askQuestion({ botId: "maus-2", prompt: "Which env?", options: ["staging", "prod"] });
    expect(q).toMatchObject({ status: "pending", options: ["staging", "prod"] });
    expect(h.manager.pendingCount()).toBe(1);

    const answered = h.manager.answerQuestion(q.id, "staging");
    expect(answered).toMatchObject({ status: "answered", answer: "staging" });
    expect(h.manager.pendingCount()).toBe(0);
    // an answered question cannot be re-answered
    expect(h.manager.answerQuestion(q.id, "prod")).toBeNull();
  });

  it("supports free-text questions (empty options)", () => {
    const h = harness();
    const q = h.manager.askQuestion({ botId: "maus-2", prompt: "What subject line?" });
    expect(q.options).toEqual([]);
    expect(h.manager.answerQuestion(q.id, "Q3 update")).toMatchObject({ answer: "Q3 update" });
  });

  it("resolves a mirrored live ask by thread/request pair", () => {
    const h = harness();
    h.manager.askQuestion({
      botId: "maus-3",
      prompt: "Allow the deploy?",
      options: ["Allow", "Deny"],
      threadId: "thread-9",
      requestId: "req-1",
    });
    const resolved = h.manager.resolveAsk("thread-9", "req-1", "allow");
    expect(resolved).toMatchObject({ status: "answered", answer: "allow" });
    // resolving again (or an unknown pair) is a no-op
    expect(h.manager.resolveAsk("thread-9", "req-1")).toBeNull();
    expect(h.manager.resolveAsk("thread-9", "req-404")).toBeNull();
  });

  it("persists questions across a reload", () => {
    const h = harness();
    const q = h.manager.askQuestion({ botId: "maus-2", prompt: "Pick one", options: ["a", "b"] });
    const reloaded = new InboxManager(h.options);
    expect(reloaded.listQuestions()).toEqual([q]);
    expect(reloaded.question(q.id)).toEqual(q);
  });
});
