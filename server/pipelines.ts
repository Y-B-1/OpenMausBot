import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

/** One step of a pipeline template. A step with `gate: "approval"` SUSPENDS
 * the run before it executes: the run waits on a token-addressed, expiring
 * human approval (buzz workflow_approvals shape) and only proceeds — or is
 * rejected — when a human decides. */
export interface TemplateStep {
  id: string;
  title: string;
  prompt: string;
  botId: string;
  gate?: "approval";
}

export interface PipelineTemplate {
  id: string;
  name: string;
  steps: TemplateStep[];
  createdAt: number;
}

export type StepState = "pending" | "running" | "done";

export type PipelineRunStatus =
  | "running"
  | "waiting_approval"
  | "done"
  | "rejected"
  | "failed"
  | "cancelled";

/** The pending gate of a suspended run — resolvable only with this token,
 * dead after `expiresAt` (an expired gate rejects the run). */
export interface PipelineApproval {
  token: string;
  stepIndex: number;
  expiresAt: number;
}

export interface PipelineRun {
  id: string;
  templateId: string;
  /** template name at start time, kept so the UI never dangles */
  name: string;
  input: string;
  /** snapshot of the template's steps at start time */
  steps: TemplateStep[];
  status: PipelineRunStatus;
  haltReason?: string;
  stepIndex: number;
  stepStates: StepState[];
  /** last assistant reply per completed step — fed into the next step's prompt */
  stepOutputs: Array<string | null>;
  /** gate indexes a human already approved */
  approvedSteps: number[];
  approval?: PipelineApproval;
  /** thread of the current/last step's task (for interrupt) */
  threadId?: string;
  startedAt: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateInput {
  name: string;
  steps: Array<{ title: string; prompt: string; botId: string; gate?: string | boolean }>;
}

interface PipelineFile {
  version: 1;
  templates: PipelineTemplate[];
  runs: PipelineRun[];
}

export interface PipelineManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  /** minutes a pending gate stays approvable (buzz expires_at) */
  approvalTtlMinutes?: number;
  botState: (botId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string) => Promise<void>;
  /** A run suspended on a gate — mirror the ask (e.g. into the Inbox). */
  onGate?: (run: PipelineRun, step: TemplateStep, token: string) => void;
  /** The gate was settled (approve/reject/expiry) — settle any mirror. */
  onGateResolved?: (run: PipelineRun, token: string, behavior: string) => void;
}

const MAX_TEMPLATES = 200;
const MAX_RUNS = 500;
const TICK_MS = 5_000;
const DEFAULT_APPROVAL_TTL_MINUTES = 60;

function cleanText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim().slice(0, max);
  if (!text) throw new Error(label);
  return text;
}

export function stepPrompt(run: PipelineRun, stepIndex: number): string {
  const step = run.steps[stepIndex]!;
  const parts = [
    `You are running step ${stepIndex + 1}/${run.steps.length} ("${step.title}") of the pipeline "${run.name}".`,
    "",
    step.prompt,
  ];
  const previous = stepIndex > 0 ? run.stepOutputs[stepIndex - 1] : null;
  if (previous) parts.push("", "Output of the previous step:", previous);
  if (run.input) parts.push("", "Pipeline input:", run.input);
  return parts.join("\n");
}

/** Runs pipeline templates step by step over existing bots: each step is one
 * bot turn in its own detached task; a gated step suspends the run on a
 * token-addressed expiring approval. Mirrors the GoalManager pattern.
 *
 * Loop prevention (buzz no-retrigger rule): runs start ONLY via `startRun`
 * (an explicit human/API action). Runtime events can advance an in-flight
 * step of an existing run, but can never create or trigger a run. */
export class PipelineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: PipelineManagerOptions;
  private readonly approvalTtlMs: number;
  private templates: PipelineTemplate[] = [];
  private runs: PipelineRun[] = [];
  /** threadId → runId for steps awaiting turn.completed */
  private readonly inFlight = new Map<string, string>();
  /** last assistant text seen for an in-flight step, per run */
  private readonly lastReply = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: PipelineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "pipelines.json");
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = (options.approvalTtlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES) * 60_000;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PipelineFile>;
      this.templates = Array.isArray(disk.templates) ? disk.templates : [];
      this.runs = Array.isArray(disk.runs) ? disk.runs : [];
    } catch {
      this.templates = [];
      this.runs = [];
    }
    // A restart loses any in-flight turn; a step that was mid-turn simply
    // runs again on the first tick. Pending gates survive (expiry included).
    for (const run of this.runs) {
      run.stepStates = run.stepStates.map((s) => (s === "running" ? "pending" : s));
    }
  }

  listTemplates(): PipelineTemplate[] {
    return this.templates.map((template) => this.copyTemplate(template));
  }

  listRuns(): PipelineRun[] {
    return this.runs.map((run) => this.copyRun(run));
  }

  getRun(id: string): PipelineRun | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    return run ? this.copyRun(run) : null;
  }

  createTemplate(input: TemplateInput): PipelineTemplate {
    const name = cleanText(input.name, "Give the template a name", 120);
    const rawSteps = Array.isArray(input.steps) ? input.steps.slice(0, 20) : [];
    const steps: TemplateStep[] = rawSteps.map((raw, index) => ({
      id: randomUUID().slice(0, 8),
      title: cleanText(raw?.title, `Step ${index + 1} needs a title`, 120),
      prompt: cleanText(raw?.prompt, `Step ${index + 1} needs a prompt`, 4_000),
      botId: cleanText(raw?.botId, `Step ${index + 1} needs a bot`, 80),
      ...(raw?.gate === "approval" || raw?.gate === true ? { gate: "approval" as const } : {}),
    }));
    if (steps.length === 0) throw new Error("Add at least one step");
    for (const step of steps) {
      if (this.options.botState(step.botId) === "missing")
        throw new Error(`The bot for step "${step.title}" no longer exists`);
    }
    const template: PipelineTemplate = { id: randomUUID(), name, steps, createdAt: this.now() };
    this.templates.unshift(template);
    if (this.templates.length > MAX_TEMPLATES) this.templates.length = MAX_TEMPLATES;
    this.save();
    this.options.emit?.({ kind: "pipeline.template", template: this.copyTemplate(template) });
    return this.copyTemplate(template);
  }

  startRun(input: { templateId: string; input?: string }): PipelineRun {
    const template = this.templates.find((candidate) => candidate.id === String(input.templateId ?? ""));
    if (!template) throw new Error("No such template");
    const at = this.now();
    const run: PipelineRun = {
      id: randomUUID(),
      templateId: template.id,
      name: template.name,
      input: String(input.input ?? "").trim().slice(0, 4_000),
      steps: template.steps.map((step) => ({ ...step })),
      status: "running",
      stepIndex: 0,
      stepStates: template.steps.map(() => "pending"),
      stepOutputs: template.steps.map(() => null),
      approvedSteps: [],
      startedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return this.copyRun(run);
  }

  /** Approve the pending gate. The token must match and be unexpired. */
  approve(runId: string, token: string): PipelineRun | null {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.status !== "waiting_approval" || !run.approval) return null;
    if (run.approval.token !== token) return null;
    const pending = run.approval;
    if (this.now() >= pending.expiresAt) {
      this.expireGate(run);
      return null;
    }
    run.approvedSteps.push(pending.stepIndex);
    run.approval = undefined;
    run.status = "running";
    run.updatedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onGateResolved?.(this.copyRun(run), pending.token, "Approve");
    queueMicrotask(() => void this.tick());
    return this.copyRun(run);
  }

  /** Reject the pending gate — the run stops and remaining steps never run. */
  reject(runId: string, token: string): PipelineRun | null {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run || run.status !== "waiting_approval" || !run.approval) return null;
    if (run.approval.token !== token) return null;
    const pending = run.approval;
    run.approval = undefined;
    this.finish(run, "rejected", `gate rejected at step ${pending.stepIndex + 1}`);
    this.options.onGateResolved?.(this.copyRun(run), pending.token, "Reject");
    return this.copyRun(run);
  }

  async cancel(id: string): Promise<PipelineRun | null> {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run || !["running", "waiting_approval"].includes(run.status)) return null;
    const pending = run.approval;
    run.approval = undefined;
    this.finish(run, "cancelled");
    if (pending) this.options.onGateResolved?.(this.copyRun(run), pending.token, "Cancel");
    if (run.threadId && this.inFlight.get(run.threadId) === run.id) {
      this.inFlight.delete(run.threadId);
      const step = run.steps[run.stepIndex];
      if (step) await this.options.interruptTurn?.(step.botId, run.threadId).catch(() => {});
    }
    return this.copyRun(run);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of this.runs) {
        if (run.status === "waiting_approval" && run.approval && this.now() >= run.approval.expiresAt) {
          this.expireGate(run);
          continue;
        }
        if (run.status !== "running") continue;
        if (run.threadId && this.inFlight.has(run.threadId)) continue;
        if (run.stepIndex >= run.steps.length) {
          this.finish(run, "done");
          continue;
        }
        const step = run.steps[run.stepIndex]!;
        if (step.gate === "approval" && !run.approvedSteps.includes(run.stepIndex)) {
          this.suspend(run, step);
          continue;
        }
        const state = this.options.botState(step.botId);
        if (state === "busy") continue; // retry next tick
        if (state === "missing") {
          this.finish(run, "failed", `the bot for step "${step.title}" no longer exists`);
          continue;
        }
        const task = this.options.createTask(step.botId, `${run.name} — ${step.title}`);
        if (!task) {
          this.finish(run, "failed", `could not create a task for step "${step.title}"`);
          continue;
        }
        run.threadId = task.threadId;
        run.stepStates[run.stepIndex] = "running";
        run.updatedAt = this.now();
        this.inFlight.set(task.threadId, run.id);
        this.lastReply.delete(run.id);
        this.save();
        this.emitRun(run);
        try {
          await this.options.startTurn(step.botId, task.threadId, stepPrompt(run, run.stepIndex), (message) =>
            this.failStep(task.threadId, message),
          );
        } catch (error) {
          this.failStep(task.threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent) {
    const runId = this.inFlight.get(event.threadId);
    const run = runId ? this.runs.find((candidate) => candidate.id === runId) : undefined;
    if (!run) return; // never triggers runs — advance-only (no-retrigger rule)
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      this.lastReply.set(run.id, event.text.trim().slice(0, 8_000));
      return;
    }
    if (event.type !== "turn.completed") return;
    this.inFlight.delete(event.threadId);
    const index = run.stepIndex;
    if (!event.ok) {
      this.finish(run, "failed", `step ${index + 1} ("${run.steps[index]?.title ?? "?"}") failed`);
      return;
    }
    run.stepStates[index] = "done";
    run.stepOutputs[index] = this.lastReply.get(run.id) ?? null;
    this.lastReply.delete(run.id);
    run.stepIndex = index + 1;
    if (run.stepIndex >= run.steps.length) {
      this.finish(run, "done");
      return;
    }
    run.updatedAt = this.now();
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
  }

  /** A step that never reached the provider fails the run — pipelines are
   * ordered work, so there is no meaningful way to continue past a hole. */
  failStep(threadId: string, message: string) {
    const runId = this.inFlight.get(threadId);
    const run = runId ? this.runs.find((candidate) => candidate.id === runId) : undefined;
    if (!run) return;
    this.inFlight.delete(threadId);
    this.finish(run, "failed", `step ${run.stepIndex + 1} error: ${message.slice(0, 500)}`);
  }

  private suspend(run: PipelineRun, step: TemplateStep) {
    const token = randomUUID();
    run.status = "waiting_approval";
    run.approval = { token, stepIndex: run.stepIndex, expiresAt: this.now() + this.approvalTtlMs };
    run.updatedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onGate?.(this.copyRun(run), { ...step }, token);
  }

  private expireGate(run: PipelineRun) {
    const pending = run.approval;
    run.approval = undefined;
    this.finish(run, "rejected", `approval expired at step ${(pending?.stepIndex ?? 0) + 1}`);
    if (pending) this.options.onGateResolved?.(this.copyRun(run), pending.token, "Expired");
  }

  private finish(run: PipelineRun, status: PipelineRunStatus, haltReason?: string) {
    run.status = status;
    run.haltReason = haltReason;
    run.finishedAt = this.now();
    run.updatedAt = run.finishedAt;
    this.lastReply.delete(run.id);
    this.save();
    this.emitRun(run);
  }

  private copyTemplate(template: PipelineTemplate): PipelineTemplate {
    return { ...template, steps: template.steps.map((step) => ({ ...step })) };
  }

  private copyRun(run: PipelineRun): PipelineRun {
    return {
      ...run,
      steps: run.steps.map((step) => ({ ...step })),
      stepStates: [...run.stepStates],
      stepOutputs: [...run.stepOutputs],
      approvedSteps: [...run.approvedSteps],
      approval: run.approval ? { ...run.approval } : undefined,
    };
  }

  private emitRun(run: PipelineRun) {
    this.options.emit?.({ kind: "pipeline.run", run: this.copyRun(run) });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify(
        { version: 1, templates: this.templates, runs: this.runs } satisfies PipelineFile,
        null,
        2,
      ),
    );
  }
}
