import { useMemo, useState } from "react";
import {
  Ban,
  Check,
  CheckCircle2,
  Circle,
  CircleCheck,
  Loader2,
  OctagonAlert,
  Play,
  Plus,
  ShieldQuestion,
  Trash2,
  Workflow,
  X,
} from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { PipelineRun, PipelineRunStatus, PipelineTemplate } from "@/lib/pipelines";
import { useStore, type Bot } from "@/state/store";

const STATUS_META: Record<PipelineRunStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/15 text-accent" },
  waiting_approval: { label: "Waiting for approval", className: "bg-warning/15 text-warning" },
  done: { label: "Done", className: "bg-success/15 text-success" },
  rejected: { label: "Rejected", className: "bg-danger/15 text-danger" },
  failed: { label: "Failed", className: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", className: "bg-raised text-ink-secondary" },
};

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: PipelineRunStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className)}>{meta.label}</span>
  );
}

function RunRow({ run, active, onSelect }: { run: PipelineRun; active: boolean; onSelect: () => void }) {
  const done = run.stepStates.filter((s) => s === "done").length;
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <span className="flex size-8 items-center justify-center rounded-full bg-raised text-ink-secondary">
        <Workflow size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{run.name}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-secondary/70">
            {niceWhen(run.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-secondary">
          <StatusBadge status={run.status} />
          <span className="tabular-nums">
            {done}/{run.steps.length} steps
          </span>
        </span>
      </span>
    </button>
  );
}

function RunDetail({ run, botFor }: { run: PipelineRun; botFor: (botId: string) => Bot | undefined }) {
  const { dispatch } = useStore();
  const gate = run.approval;
  return (
    <div className="mx-auto w-full max-w-[640px] px-8 py-10">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-full bg-raised text-ink-secondary">
          <Workflow size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{run.name}</div>
          <div className="text-[12px] text-ink-secondary">started {niceWhen(run.startedAt)}</div>
        </div>
        <StatusBadge status={run.status} />
      </div>

      {["rejected", "failed"].includes(run.status) && run.haltReason && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
          <OctagonAlert size={15} className="shrink-0" />
          {run.haltReason}
        </div>
      )}

      {run.input && (
        <div className="mt-4 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5 text-[13px] text-ink-secondary">
          Input: <span className="text-ink">{run.input}</span>
        </div>
      )}

      <div className="mt-5">
        <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Steps</div>
        <div className="mt-2 flex flex-col gap-1.5">
          {run.steps.map((step, index) => {
            const state = run.stepStates[index];
            const bot = botFor(step.botId);
            const isGateHere = run.status === "waiting_approval" && gate?.stepIndex === index;
            return (
              <div
                key={step.id}
                className={cn(
                  "rounded-xl border bg-panel px-3.5 py-2.5",
                  isGateHere ? "border-warning/50" : "border-hairline/50",
                )}
              >
                <div className="flex items-start gap-2.5">
                  {state === "done" ? (
                    <CircleCheck size={16} className="mt-0.5 shrink-0 text-success" />
                  ) : state === "running" ? (
                    <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-accent" />
                  ) : isGateHere ? (
                    <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-warning" />
                  ) : (
                    <Circle size={16} className="mt-0.5 shrink-0 text-ink-secondary/50" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink">{step.title}</span>
                      {step.gate && (
                        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          gate
                        </span>
                      )}
                      {bot && (
                        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-secondary">
                          <MausAvatar color={bot.color} state="idle" size={16} animated={false} />
                          {bot.name}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{step.prompt}</div>
                    {run.stepOutputs[index] && (
                      <div className="mt-2 whitespace-pre-wrap rounded-lg bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                        {run.stepOutputs[index]}
                      </div>
                    )}
                  </div>
                </div>
                {isGateHere && gate && (
                  <div className="mt-2.5 flex items-center gap-2 border-t border-hairline/40 pt-2.5">
                    <span className="text-[12px] text-warning">Approve this step to continue.</span>
                    <button
                      onClick={() => dispatch({ type: "approvePipeline", runId: run.id, token: gate.token })}
                      className="ml-auto flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
                    >
                      <Check size={13} />
                      Approve
                    </button>
                    <button
                      onClick={() => dispatch({ type: "rejectPipeline", runId: run.id, token: gate.token })}
                      className="flex items-center gap-1.5 rounded-xl border border-hairline/60 bg-inset px-3 py-1.5 text-[12.5px] text-danger transition-colors hover:bg-danger/10"
                    >
                      <X size={13} />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {["running", "waiting_approval"].includes(run.status) && (
        <div className="mt-6">
          <button
            onClick={() => dispatch({ type: "cancelPipeline", runId: run.id })}
            className="flex items-center gap-1.5 rounded-xl border border-hairline/60 bg-inset px-3.5 py-2 text-[13px] text-danger transition-colors hover:bg-danger/10"
          >
            <Ban size={14} />
            Cancel run
          </button>
        </div>
      )}
      {run.status === "done" && (
        <div className="mt-6 flex items-center gap-2 text-[13px] text-success">
          <CheckCircle2 size={15} />
          Every step completed.
        </div>
      )}
    </div>
  );
}

interface DraftStep {
  title: string;
  prompt: string;
  botId: string;
  gate: boolean;
}

function NewTemplateForm({ bots, onClose }: { bots: Bot[]; onClose: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const emptyStep = (): DraftStep => ({ title: "", prompt: "", botId: bots[0]?.id ?? "", gate: false });
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const patch = (index: number, part: Partial<DraftStep>) =>
    setSteps((all) => all.map((step, i) => (i === index ? { ...step, ...part } : step)));
  const ready = name.trim() && steps.every((step) => step.title.trim() && step.prompt.trim() && step.botId);

  const field =
    "w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70";
  return (
    <form
      className="mx-auto w-full max-w-[560px] px-8 py-10"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        dispatch({
          type: "createPipelineTemplate",
          input: {
            name: name.trim(),
            steps: steps.map((step) => ({
              title: step.title.trim(),
              prompt: step.prompt.trim(),
              botId: step.botId,
              ...(step.gate ? { gate: "approval" as const } : {}),
            })),
          },
        });
        onClose();
      }}
    >
      <div className="text-[15px] font-semibold text-ink">New pipeline template</div>
      <div className="mt-1 text-[12.5px] text-ink-secondary">
        Steps run in order, each as one bot turn. A gated step waits for your approval first.
      </div>
      <div className="mt-5 flex flex-col gap-3">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" className={field} />
        {steps.map((step, index) => (
          <div key={index} className="rounded-xl border border-hairline/50 bg-panel p-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                Step {index + 1}
              </span>
              {steps.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSteps((all) => all.filter((_, i) => i !== index))}
                  className="ml-auto text-ink-secondary transition-colors hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={step.title}
                onChange={(e) => patch(index, { title: e.target.value })}
                placeholder="Step title"
                className={field}
              />
              <textarea
                value={step.prompt}
                onChange={(e) => patch(index, { prompt: e.target.value })}
                placeholder="Prompt for this step…"
                rows={2}
                className={cn(field, "resize-none")}
              />
              <div className="flex items-center gap-2">
                <select
                  value={step.botId}
                  onChange={(e) => patch(index, { botId: e.target.value })}
                  className={cn(field, "flex-1")}
                >
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
                <label className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={step.gate}
                    onChange={(e) => patch(index, { gate: e.target.checked })}
                    className="accent-accent"
                  />
                  Needs approval
                </label>
              </div>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setSteps((all) => [...all, emptyStep()])}
          className="flex items-center gap-1.5 self-start rounded-xl bg-raised px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-raised/70"
        >
          <Plus size={13} />
          Add step
        </button>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="submit"
          disabled={!ready}
          className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
        >
          <Workflow size={14} />
          Save template
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl px-3.5 py-2.5 text-[13px] text-ink-secondary transition-colors hover:bg-raised/50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function TemplateRow({ template, onStart }: { template: PipelineTemplate; onStart: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-raised/40">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{template.name}</span>
        <span className="text-[11.5px] text-ink-secondary">
          {template.steps.length} step{template.steps.length === 1 ? "" : "s"}
          {template.steps.some((step) => step.gate) ? " · gated" : ""}
        </span>
      </span>
      <button
        onClick={onStart}
        className="flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised/70"
      >
        <Play size={12} />
        Run
      </button>
    </div>
  );
}

export function PipelinesPage() {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const runs = useMemo(
    () => [...state.pipelineRuns].sort((a, b) => b.updatedAt - a.updatedAt),
    [state.pipelineRuns],
  );
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const activeCount = runs.filter((run) => ["running", "waiting_approval"].includes(run.status)).length;
  const botFor = (botId: string) => state.bots.find((bot) => bot.id === botId);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);

  return (
    <main className="flex h-full min-w-0 flex-1 bg-app">
      {/* list pane */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-hairline/40">
        <div className="px-4 pb-2 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-[17px] font-semibold text-ink">Pipelines</div>
            {activeCount > 0 && (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                {activeCount}
              </span>
            )}
            <button
              onClick={() => setCreating(true)}
              className="ml-auto flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised/70"
            >
              <Plus size={13} />
              New
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
            Templates
          </div>
          {state.pipelineTemplates.length === 0 ? (
            <div className="px-3 py-3 text-[12.5px] text-ink-secondary">No templates yet.</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {state.pipelineTemplates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onStart={() => dispatch({ type: "startPipeline", templateId: template.id, input: "" })}
                />
              ))}
            </div>
          )}
          <div className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
            Runs
          </div>
          {runs.length === 0 ? (
            <div className="px-3 py-3 text-[12.5px] text-ink-secondary">No run has started yet.</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  active={!creating && selected?.id === run.id}
                  onSelect={() => {
                    setCreating(false);
                    setSelectedId(run.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {/* detail pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {creating ? (
          <NewTemplateForm bots={visibleBots} onClose={() => setCreating(false)} />
        ) : selected ? (
          <RunDetail key={selected.id} run={selected} botFor={botFor} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
            <Workflow size={22} />
            <div className="text-[14px]">Chain bot steps into a pipeline, with approval gates where it matters.</div>
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white"
            >
              <Plus size={14} />
              New template
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
