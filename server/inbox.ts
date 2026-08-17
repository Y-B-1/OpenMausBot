import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

/** A cross-bot status message from an agent (or tool) to the human. */
export interface InboxItem {
  id: string;
  botId: string;
  text: string;
  ts: number;
  status: "open" | "replied";
  reply?: string;
  repliedAt?: number;
}

/** A question a bot needs answered. Empty `options` = free-text question.
 * Questions mirrored from a live provider ask carry the thread/request pair
 * so answering them from the Inbox resolves the blocked turn. */
export interface InboxQuestion {
  id: string;
  botId: string;
  prompt: string;
  options: string[];
  ts: number;
  status: "pending" | "answered";
  answer?: string;
  answeredAt?: number;
  threadId?: string;
  requestId?: string;
}

interface InboxFile {
  version: 1;
  items: InboxItem[];
  questions: InboxQuestion[];
}

export interface InboxManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
}

const MAX_ROWS = 2_000;

function cleanText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim().slice(0, max);
  if (!text) throw new Error(label);
  return text;
}

export class InboxManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: InboxManagerOptions;
  private items: InboxItem[] = [];
  private questions: InboxQuestion[] = [];

  constructor(options: InboxManagerOptions = {}) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "inbox.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<InboxFile>;
      this.items = Array.isArray(disk.items) ? disk.items : [];
      this.questions = Array.isArray(disk.questions) ? disk.questions : [];
    } catch {
      this.items = [];
      this.questions = [];
    }
  }

  listItems(): InboxItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  listQuestions(): InboxQuestion[] {
    return this.questions.map((q) => ({ ...q, options: [...q.options] }));
  }

  /** Open items + pending questions — the sidebar badge count. */
  pendingCount(): number {
    return (
      this.items.filter((item) => item.status === "open").length +
      this.questions.filter((q) => q.status === "pending").length
    );
  }

  postItem(input: { botId: string; text: string }): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      botId: cleanText(input.botId, "The item needs a bot", 80),
      text: cleanText(input.text, "The item needs a message", 20_000),
      ts: this.now(),
      status: "open",
    };
    this.items.unshift(item);
    if (this.items.length > MAX_ROWS) this.items.length = MAX_ROWS;
    this.save();
    this.emitItem(item);
    return { ...item };
  }

  replyItem(id: string, reply: string): InboxItem | null {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    item.reply = cleanText(reply, "Write a reply", 20_000);
    item.status = "replied";
    item.repliedAt = this.now();
    this.save();
    this.emitItem(item);
    return { ...item };
  }

  askQuestion(input: {
    botId: string;
    prompt: string;
    options?: string[];
    threadId?: string;
    requestId?: string;
  }): InboxQuestion {
    const question: InboxQuestion = {
      id: randomUUID(),
      botId: cleanText(input.botId, "The question needs a bot", 80),
      prompt: cleanText(input.prompt, "The question needs a prompt", 20_000),
      options: Array.isArray(input.options)
        ? input.options.map((option) => String(option).slice(0, 200)).filter(Boolean).slice(0, 12)
        : [],
      ts: this.now(),
      status: "pending",
      threadId: input.threadId,
      requestId: input.requestId,
    };
    this.questions.unshift(question);
    if (this.questions.length > MAX_ROWS) this.questions.length = MAX_ROWS;
    this.save();
    this.emitQuestion(question);
    return { ...question, options: [...question.options] };
  }

  question(id: string): InboxQuestion | null {
    const q = this.questions.find((candidate) => candidate.id === id);
    return q ? { ...q, options: [...q.options] } : null;
  }

  answerQuestion(id: string, answer: string): InboxQuestion | null {
    const question = this.questions.find((candidate) => candidate.id === id);
    if (!question || question.status === "answered") return null;
    question.answer = cleanText(answer, "Write an answer", 20_000);
    question.status = "answered";
    question.answeredAt = this.now();
    this.save();
    this.emitQuestion(question);
    return { ...question, options: [...question.options] };
  }

  /** A live provider ask was resolved elsewhere (chat card, auto mode) —
   * settle the mirrored question so the Inbox never shows a stale block. */
  resolveAsk(threadId: string, requestId: string, answer?: string): InboxQuestion | null {
    const question = this.questions.find(
      (candidate) =>
        candidate.threadId === threadId &&
        candidate.requestId === requestId &&
        candidate.status === "pending",
    );
    if (!question) return null;
    question.answer = answer?.trim().slice(0, 20_000) || undefined;
    question.status = "answered";
    question.answeredAt = this.now();
    this.save();
    this.emitQuestion(question);
    return { ...question, options: [...question.options] };
  }

  private emitItem(item: InboxItem) {
    this.options.emit?.({ kind: "inbox.item", item: { ...item } });
  }

  private emitQuestion(question: InboxQuestion) {
    this.options.emit?.({ kind: "inbox.question", question: { ...question, options: [...question.options] } });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, items: this.items, questions: this.questions } satisfies InboxFile, null, 2),
    );
  }
}
