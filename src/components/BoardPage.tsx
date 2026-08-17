import { useMemo } from "react";
import { CalendarDays, HelpCircle, Kanban, Mail, MessageSquare, Target, Workflow } from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { BOARD_COLUMNS, computeBoard, type BoardCard } from "@/lib/board";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

const KIND_ICON: Record<BoardCard["kind"], typeof Target> = {
  task: MessageSquare,
  goal: Target,
  question: HelpCircle,
  note: Mail,
  routine: CalendarDays,
  pipeline: Workflow,
};

function Card({ card }: { card: BoardCard }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === card.botId);
  const Icon = KIND_ICON[card.kind];
  return (
    <button
      onClick={() => {
        if (card.nav.view === "chat") dispatch({ type: "select", id: card.nav.botId });
        else if (card.nav.view === "goals") dispatch({ type: "showGoals" });
        else if (card.nav.view === "inbox") dispatch({ type: "showInbox" });
        else if (card.nav.view === "pipelines") dispatch({ type: "showPipelines" });
        else dispatch({ type: "showRoutines" });
      }}
      className="flex w-full flex-col gap-1.5 rounded-xl border border-hairline/50 bg-panel px-3 py-2.5 text-left transition-colors hover:bg-raised/50"
    >
      <span className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{card.title}</span>
      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
        {bot ? (
          <MausAvatar color={bot.color} state="idle" size={16} animated={false} />
        ) : (
          <Icon size={12} className="shrink-0" />
        )}
        <span className="truncate">{card.subtitle}</span>
      </span>
    </button>
  );
}

export function BoardPage() {
  const { state } = useStore();
  const board = useMemo(
    () =>
      computeBoard({
        bots: state.bots,
        goals: state.goals,
        inboxItems: state.inboxItems,
        inboxQuestions: state.inboxQuestions,
        routineRuns: state.routineRuns,
        pipelineRuns: state.pipelineRuns,
      }),
    [state.bots, state.goals, state.inboxItems, state.inboxQuestions, state.routineRuns, state.pipelineRuns],
  );
  const empty = BOARD_COLUMNS.every((column) => board[column.key].length === 0);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="px-6 pb-2 pt-4">
        <div className="text-[17px] font-semibold text-ink">Board</div>
        <div className="text-[12.5px] text-ink-secondary">
          Everything in flight, at a glance. “Waiting on human” can’t move without you.
        </div>
      </div>
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-secondary">
          <Kanban size={22} />
          <div className="text-[14px]">Nothing in flight — tasks, goals, questions and routines land here.</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto px-4 pb-4">
          <div className="flex h-full min-w-max gap-3">
            {BOARD_COLUMNS.map((column) => (
              <div key={column.key} className="flex h-full w-[250px] shrink-0 flex-col rounded-2xl bg-inset/50 p-2">
                <div className="flex items-center gap-2 px-1.5 pb-2 pt-1">
                  <span className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">
                    {column.label}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                      board[column.key].length > 0 ? "bg-raised text-ink" : "text-ink-secondary/60",
                    )}
                  >
                    {board[column.key].length}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex flex-col gap-1.5">
                    {board[column.key].map((card) => (
                      <Card key={card.id} card={card} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
