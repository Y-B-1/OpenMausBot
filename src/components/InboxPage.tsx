import { useMemo, useState } from "react";
import { CheckCircle2, CircleHelp, Inbox as InboxIcon, MessageCircle, Send } from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { InboxItem, InboxQuestion } from "@/lib/inbox";
import { useStore, type Bot } from "@/state/store";

type Entry =
  | { kind: "item"; id: string; at: number; pending: boolean; item: InboxItem }
  | { kind: "question"; id: string; at: number; pending: boolean; question: InboxQuestion };

type Filter = "needs-you" | "all" | "done";

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function EntryRow({ entry, bot, active, onSelect }: { entry: Entry; bot?: Bot; active: boolean; onSelect: () => void }) {
  const text = entry.kind === "question" ? entry.question.prompt : entry.item.text;
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {bot ? (
        <MausAvatar color={bot.color} state={entry.pending ? "curious" : "idle"} size={32} animated={false} />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-full bg-raised text-ink-secondary">
          <MessageCircle size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{bot?.name ?? "Unknown bot"}</span>
          {entry.kind === "question" && (
            <CircleHelp size={13} className={entry.pending ? "text-warning" : "text-ink-secondary/60"} />
          )}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-secondary/70">{niceWhen(entry.at)}</span>
        </span>
        <span className={cn("mt-0.5 line-clamp-2 text-[12.5px]", entry.pending ? "text-ink" : "text-ink-secondary")}>
          {text}
        </span>
      </span>
      {entry.pending && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />}
    </button>
  );
}

function QuestionDetail({ question, bot }: { question: InboxQuestion; bot?: Bot }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const answer = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) dispatch({ type: "answerInboxQuestion", questionId: question.id, answer: trimmed });
  };
  return (
    <div className="mx-auto w-full max-w-[620px] px-8 py-10">
      <div className="flex items-center gap-3">
        {bot && <MausAvatar color={bot.color} state={question.status === "pending" ? "curious" : "proud"} size={38} animated={false} />}
        <div>
          <div className="text-[15px] font-semibold text-ink">{bot?.name ?? "Unknown bot"} has a question</div>
          <div className="text-[12px] text-ink-secondary">{niceWhen(question.ts)}</div>
        </div>
      </div>
      <div className="mt-5 whitespace-pre-wrap rounded-2xl border border-hairline/50 bg-panel px-4 py-3.5 text-[14px] leading-relaxed text-ink">
        {question.prompt}
      </div>
      {question.status === "answered" ? (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-success">
          <CheckCircle2 size={15} />
          Answered{question.answer ? `: ${question.answer}` : ""}
        </div>
      ) : question.options.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              onClick={() => answer(option)}
              className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2 text-[13px] text-ink transition-colors hover:border-accent/70 hover:bg-accent/10"
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            answer(draft);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type an answer…"
            className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            <Send size={14} />
            Answer
          </button>
        </form>
      )}
    </div>
  );
}

function ItemDetail({ item, bot }: { item: InboxItem; bot?: Bot }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState("");
  return (
    <div className="mx-auto w-full max-w-[620px] px-8 py-10">
      <div className="flex items-center gap-3">
        {bot && <MausAvatar color={bot.color} state="idle" size={38} animated={false} />}
        <div>
          <div className="text-[15px] font-semibold text-ink">{bot?.name ?? "Unknown bot"}</div>
          <div className="text-[12px] text-ink-secondary">{niceWhen(item.ts)}</div>
        </div>
      </div>
      <div className="mt-5 whitespace-pre-wrap rounded-2xl border border-hairline/50 bg-panel px-4 py-3.5 text-[14px] leading-relaxed text-ink">
        {item.text}
      </div>
      {item.status === "replied" ? (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-success">
          <CheckCircle2 size={15} />
          Replied{item.reply ? `: ${item.reply}` : ""}
        </div>
      ) : (
        <form
          className="mt-4 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const reply = draft.trim();
            if (reply) dispatch({ type: "replyInboxItem", itemId: item.id, reply });
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a reply…"
            className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            <Send size={14} />
            Reply
          </button>
        </form>
      )}
    </div>
  );
}

export function InboxPage() {
  const { state } = useStore();
  const [filter, setFilter] = useState<Filter>("needs-you");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const entries = useMemo<Entry[]>(() => {
    const rows: Entry[] = [
      ...state.inboxQuestions.map((question) => ({
        kind: "question" as const,
        id: question.id,
        at: question.ts,
        pending: question.status === "pending",
        question,
      })),
      ...state.inboxItems.map((item) => ({
        kind: "item" as const,
        id: item.id,
        at: item.ts,
        pending: item.status === "open",
        item,
      })),
    ];
    return rows
      .filter((row) => (filter === "all" ? true : filter === "needs-you" ? row.pending : !row.pending))
      .sort((a, b) => Number(b.pending) - Number(a.pending) || b.at - a.at);
  }, [state.inboxItems, state.inboxQuestions, filter]);

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;
  const pendingCount =
    state.inboxItems.filter((item) => item.status === "open").length +
    state.inboxQuestions.filter((question) => question.status === "pending").length;
  const botFor = (botId: string) => state.bots.find((bot) => bot.id === botId);

  return (
    <main className="flex h-full min-w-0 flex-1 bg-app">
      {/* list pane */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-hairline/40">
        <div className="px-4 pb-2 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-[17px] font-semibold text-ink">Inbox</div>
            {pendingCount > 0 && (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                {pendingCount}
              </span>
            )}
          </div>
          <div className="mt-3 flex gap-1">
            {(
              [
                ["needs-you", "Needs you"],
                ["all", "All"],
                ["done", "Done"],
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
          {entries.length === 0 ? (
            <div className="px-3 py-10 text-center text-[13px] text-ink-secondary">
              {filter === "needs-you" ? "Nothing needs you right now." : "Nothing here yet."}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  bot={botFor(entry.kind === "question" ? entry.question.botId : entry.item.botId)}
                  active={selected?.id === entry.id}
                  onSelect={() => setSelectedId(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {/* detail pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          selected.kind === "question" ? (
            <QuestionDetail
              key={selected.id}
              question={selected.question}
              bot={botFor(selected.question.botId)}
            />
          ) : (
            <ItemDetail key={selected.id} item={selected.item} bot={botFor(selected.item.botId)} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
            <InboxIcon size={22} />
            <div className="text-[14px]">Agent updates and questions land here.</div>
          </div>
        )}
      </div>
    </main>
  );
}
