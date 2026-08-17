import { useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleCheck,
  OctagonAlert,
  Pause,
  Play,
  Plus,
  Target,
} from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { Goal, GoalStatus } from "@/lib/goals";
import { useStore, type Bot } from "@/state/store";

type Filter = "active" | "all" | "finished";

const STATUS_META: Record<GoalStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/15 text-accent" },
  paused: { label: "Paused", className: "bg-raised text-ink-secondary" },
  done: { label: "Done", className: "bg-success/15 text-success" },
  halted: { label: "Halted", className: "bg-danger/15 text-danger" },
  cancelled: { label: "Cancelled", className: "bg-raised text-ink-secondary" },
};

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: GoalStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className)}>{meta.label}</span>
  );
}

function GoalRow({ goal, bot, active, onSelect }: { goal: Goal; bot?: Bot; active: boolean; onSelect: () => void }) {
  const doneCount = goal.criteria.filter((criterion) => criterion.done).length;
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {bot ? (
        <MausAvatar color={bot.color} state={goal.status === "running" ? "working" : "idle"} size={32} animated={false} />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-full bg-raised text-ink-secondary">
          <Target size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{goal.name}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-secondary/70">
            {niceWhen(goal.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-secondary">
          <StatusBadge status={goal.status} />
          <span className="tabular-nums">
            {doneCount}/{goal.criteria.length} criteria
          </span>
        </span>
      </span>
    </button>
  );
}

function Meter({ label, value, cap, format }: { label: string; value: number; cap: number; format: (n: number) => string }) {
  const share = cap > 0 ? Math.min(1, value / cap) : 0;
  return (
    <div className="rounded-xl border border-hairline/50 bg-panel px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-ink-secondary">{label}</span>
        <span className="text-[12px] tabular-nums text-ink">
          {format(value)} / {format(cap)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset">
        <div
          className={cn("h-full rounded-full", share >= 1 ? "bg-danger" : share >= 0.75 ? "bg-warning" : "bg-accent")}
          style={{ width: `${Math.max(3, share * 100)}%` }}
        />
      </div>
    </div>
  );
}

function GoalDetail({ goal, bot }: { goal: Goal; bot?: Bot }) {
  const { dispatch } = useStore();
  const g = goal.guardrails;
  const elapsedMinutes = ((goal.finishedAt ?? Date.now()) - goal.startedAt) / 60_000;
  return (
    <div className="mx-auto w-full max-w-[640px] px-8 py-10">
      <div className="flex items-center gap-3">
        {bot && (
          <MausAvatar
            color={bot.color}
            state={goal.status === "running" ? "working" : goal.status === "done" ? "proud" : "idle"}
            size={38}
            animated={false}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{goal.name}</div>
          <div className="text-[12px] text-ink-secondary">
            {bot?.name ?? "Unknown bot"} · started {niceWhen(goal.startedAt)}
          </div>
        </div>
        <StatusBadge status={goal.status} />
      </div>

      {goal.status === "halted" && goal.haltReason && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
          <OctagonAlert size={15} className="shrink-0" />
          Guardrail stop: {goal.haltReason}
        </div>
      )}

      <div className="mt-5">
        <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Success criteria</div>
        <div className="mt-2 flex flex-col gap-1.5">
          {goal.criteria.map((criterion) => (
            <div
              key={criterion.id}
              className="flex items-start gap-2.5 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5"
            >
              {criterion.done ? (
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-success" />
              ) : (
                <Circle size={16} className="mt-0.5 shrink-0 text-ink-secondary/50" />
              )}
              <span className={cn("text-[13.5px] leading-relaxed", criterion.done ? "text-ink-secondary line-through" : "text-ink")}>
                {criterion.text}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Guardrails</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Meter label="Sessions" value={goal.sessions} cap={g.maxSessions} format={(n) => `${Math.round(n)}`} />
          <Meter label="Spend" value={goal.spentUsd} cap={g.spendCapUsd} format={(n) => `$${n.toFixed(2)}`} />
          <Meter label="Wall clock" value={elapsedMinutes} cap={g.wallClockMinutes} format={(n) => `${Math.round(n)}m`} />
          <Meter label="Stuck sessions" value={goal.stuck} cap={g.stuckThreshold} format={(n) => `${Math.round(n)}`} />
        </div>
      </div>

      {goal.lastReply && (
        <div className="mt-5">
          <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Last reply</div>
          <div className="mt-2 whitespace-pre-wrap rounded-2xl border border-hairline/50 bg-panel px-4 py-3.5 text-[13.5px] leading-relaxed text-ink">
            {goal.lastReply}
          </div>
        </div>
      )}

      {["running", "paused"].includes(goal.status) && (
        <div className="mt-6 flex items-center gap-2">
          {goal.status === "running" ? (
            <button
              onClick={() => dispatch({ type: "pauseGoal", goalId: goal.id })}
              className="flex items-center gap-1.5 rounded-xl border border-hairline/60 bg-inset px-3.5 py-2 text-[13px] text-ink transition-colors hover:bg-raised"
            >
              <Pause size={14} />
              Pause
            </button>
          ) : (
            <button
              onClick={() => dispatch({ type: "resumeGoal", goalId: goal.id })}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white"
            >
              <Play size={14} />
              Resume
            </button>
          )}
          <button
            onClick={() => dispatch({ type: "cancelGoal", goalId: goal.id })}
            className="flex items-center gap-1.5 rounded-xl border border-hairline/60 bg-inset px-3.5 py-2 text-[13px] text-danger transition-colors hover:bg-danger/10"
          >
            <Ban size={14} />
            Cancel
          </button>
        </div>
      )}
      {goal.status === "done" && (
        <div className="mt-6 flex items-center gap-2 text-[13px] text-success">
          <CheckCircle2 size={15} />
          Every criterion is satisfied.
        </div>
      )}
    </div>
  );
}

function NewGoalForm({ bots, onClose }: { bots: Bot[]; onClose: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [criteria, setCriteria] = useState("");
  const [maxSessions, setMaxSessions] = useState("10");
  const [spendCapUsd, setSpendCapUsd] = useState("5");
  const [wallClockMinutes, setWallClockMinutes] = useState("120");
  const lines = criteria
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const ready = name.trim() && botId && lines.length > 0;

  const field =
    "w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70";
  return (
    <form
      className="mx-auto w-full max-w-[560px] px-8 py-10"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        dispatch({
          type: "createGoal",
          input: {
            name: name.trim(),
            botId,
            criteria: lines,
            guardrails: {
              maxSessions: Number(maxSessions) || undefined,
              spendCapUsd: Number(spendCapUsd) || undefined,
              wallClockMinutes: Number(wallClockMinutes) || undefined,
            },
          },
        });
        onClose();
      }}
    >
      <div className="text-[15px] font-semibold text-ink">New goal</div>
      <div className="mt-1 text-[12.5px] text-ink-secondary">
        The bot works session by session until every criterion is met — or a guardrail stops it.
      </div>
      <div className="mt-5 flex flex-col gap-3">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Goal name" className={field} />
        <select value={botId} onChange={(e) => setBotId(e.target.value)} className={field}>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          placeholder={"Success criteria, one per line…"}
          rows={4}
          className={cn(field, "resize-none")}
        />
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["Max sessions", maxSessions, setMaxSessions],
              ["Spend cap $", spendCapUsd, setSpendCapUsd],
              ["Wall clock min", wallClockMinutes, setWallClockMinutes],
            ] as Array<[string, string, (v: string) => void]>
          ).map(([label, value, set]) => (
            <label key={label} className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-secondary">{label}</span>
              <input value={value} onChange={(e) => set(e.target.value)} inputMode="numeric" className={field} />
            </label>
          ))}
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <button
          type="submit"
          disabled={!ready}
          className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
        >
          <Target size={14} />
          Start goal
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

export function GoalsPage() {
  const { state } = useStore();
  const [filter, setFilter] = useState<Filter>("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const goals = useMemo(
    () =>
      state.goals
        .filter((goal) =>
          filter === "all"
            ? true
            : filter === "active"
              ? ["running", "paused"].includes(goal.status)
              : ["done", "halted", "cancelled"].includes(goal.status),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.goals, filter],
  );
  const selected = goals.find((goal) => goal.id === selectedId) ?? goals[0] ?? null;
  const runningCount = state.goals.filter((goal) => goal.status === "running").length;
  const botFor = (botId: string) => state.bots.find((bot) => bot.id === botId);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);

  return (
    <main className="flex h-full min-w-0 flex-1 bg-app">
      {/* list pane */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-hairline/40">
        <div className="px-4 pb-2 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-[17px] font-semibold text-ink">Goals</div>
            {runningCount > 0 && (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                {runningCount}
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
          <div className="mt-3 flex gap-1">
            {(
              [
                ["active", "Active"],
                ["all", "All"],
                ["finished", "Finished"],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[12px] transition-colors",
                  filter === value ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {goals.length === 0 ? (
            <div className="px-3 py-10 text-center text-[13px] text-ink-secondary">
              {filter === "active" ? "No goal is running right now." : "Nothing here yet."}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {goals.map((goal) => (
                <GoalRow
                  key={goal.id}
                  goal={goal}
                  bot={botFor(goal.botId)}
                  active={!creating && selected?.id === goal.id}
                  onSelect={() => {
                    setCreating(false);
                    setSelectedId(goal.id);
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
          <NewGoalForm bots={visibleBots} onClose={() => setCreating(false)} />
        ) : selected ? (
          <GoalDetail key={selected.id} goal={selected} bot={botFor(selected.botId)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
            <Target size={22} />
            <div className="text-[14px]">Give a bot a goal and it works until the criteria are met.</div>
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white"
            >
              <Plus size={14} />
              New goal
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
