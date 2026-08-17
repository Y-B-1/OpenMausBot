import { Bot as BotIcon, CalendarDays, CircleDollarSign, MessageSquare, Target, Workflow } from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { CostSource } from "@/lib/costs";
import { useStore } from "@/state/store";

// P8: the cost ledger — provider-reported per-turn spend, teed off the event
// bus and attributed to whatever started the turn (chat, goal, pipeline,
// routine). Totals include days already collapsed into rollups.

const SOURCE_META: Record<CostSource, { label: string; icon: typeof Target; className: string }> = {
  chat: { label: "Chat", icon: MessageSquare, className: "text-accent" },
  goal: { label: "Goals", icon: Target, className: "text-success" },
  pipeline: { label: "Pipelines", icon: Workflow, className: "text-warning" },
  routine: { label: "Routines", icon: CalendarDays, className: "text-danger" },
};
const SOURCES = Object.keys(SOURCE_META) as CostSource[];

function usd(value: number) {
  return `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-hairline/50 bg-panel px-4 py-3">
      <span className="text-[12px] uppercase tracking-wide text-ink-secondary">{label}</span>
      <span className="text-[22px] font-semibold tabular-nums text-ink">{value}</span>
      {sub && <span className="text-[11.5px] text-ink-secondary">{sub}</span>}
    </div>
  );
}

function Bar({ fraction, className }: { fraction: number; className?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
      <div
        className={cn("h-full rounded-full bg-accent", className)}
        style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
      />
    </div>
  );
}

export function CostsPage() {
  const { state } = useStore();
  const summary = state.costs;
  const botName = (botId: string | null) =>
    botId ? (state.bots.find((b) => b.id === botId)?.name ?? botId.slice(0, 8)) : "—";

  if (!summary) {
    const memberBlocked = Boolean(state.org?.orgMode) && state.orgMe?.role !== "admin";
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
        <CircleDollarSign size={22} />
        <div className="text-[14px]">
          {memberBlocked ? "Spend is visible to admins only." : "No spend recorded yet."}
        </div>
      </main>
    );
  }

  const maxBot = Math.max(...summary.byBot.map((b) => b.costUsd), 0.000001);
  const sourceTotal = Math.max(
    SOURCES.reduce((sum, source) => sum + summary.bySource[source], 0),
    0.000001,
  );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="px-6 pb-2 pt-4">
        <div className="text-[17px] font-semibold text-ink">Costs</div>
        <div className="text-[12.5px] text-ink-secondary">
          What the bots actually spent — provider-reported, per completed turn.
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="grid max-w-3xl grid-cols-3 gap-3">
          <StatCard label="Today" value={usd(summary.totals.todayUsd)} />
          <StatCard label="Last 7 days" value={usd(summary.totals.last7DaysUsd)} />
          <StatCard label="All time" value={usd(summary.totals.allTimeUsd)} sub={`${summary.totals.turns} turns`} />
        </div>

        <div className="mt-5 grid max-w-3xl gap-3 md:grid-cols-2">
          {/* per-bot breakdown */}
          <div className="rounded-2xl border border-hairline/50 bg-panel p-4">
            <div className="pb-3 text-[13px] font-medium text-ink">By bot</div>
            {summary.byBot.length === 0 ? (
              <div className="text-[12.5px] text-ink-secondary">No attributed spend yet.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {summary.byBot.slice(0, 8).map((row) => {
                  const bot = state.bots.find((b) => b.id === row.botId);
                  return (
                    <div key={row.botId} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        {bot ? (
                          <MausAvatar color={bot.color} state="idle" size={16} animated={false} />
                        ) : (
                          <BotIcon size={14} className="text-ink-secondary" />
                        )}
                        <span className="flex-1 truncate text-[12.5px] text-ink">{botName(row.botId)}</span>
                        <span className="text-[12px] tabular-nums text-ink-secondary">{usd(row.costUsd)}</span>
                      </div>
                      <Bar fraction={row.costUsd / maxBot} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* per-source split */}
          <div className="rounded-2xl border border-hairline/50 bg-panel p-4">
            <div className="pb-3 text-[13px] font-medium text-ink">By source</div>
            <div className="flex flex-col gap-3">
              {SOURCES.map((source) => {
                const meta = SOURCE_META[source];
                const Icon = meta.icon;
                const value = summary.bySource[source];
                return (
                  <div key={source} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className={meta.className} />
                      <span className="flex-1 text-[12.5px] text-ink">{meta.label}</span>
                      <span className="text-[12px] tabular-nums text-ink-secondary">{usd(value)}</span>
                    </div>
                    <Bar fraction={value / sourceTotal} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* recent turns */}
        <div className="mt-5 max-w-3xl rounded-2xl border border-hairline/50 bg-panel p-4">
          <div className="pb-3 text-[13px] font-medium text-ink">Recent turns</div>
          {summary.recent.length === 0 ? (
            <div className="text-[12.5px] text-ink-secondary">
              Turns land here as soon as a provider reports a cost.
            </div>
          ) : (
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-ink-secondary">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Bot</th>
                  <th className="pb-2 pr-3 font-medium">Source</th>
                  <th className="pb-2 pr-3 font-medium">Model</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.map((entry) => (
                  <tr key={entry.id} className="border-t border-hairline/40 text-ink">
                    <td className="py-1.5 pr-3 tabular-nums text-ink-secondary">{niceWhen(entry.ts)}</td>
                    <td className="py-1.5 pr-3">{botName(entry.botId)}</td>
                    <td className="py-1.5 pr-3 text-ink-secondary">{SOURCE_META[entry.source].label}</td>
                    <td className="max-w-[160px] truncate py-1.5 pr-3 text-ink-secondary">{entry.model ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{usd(entry.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}
