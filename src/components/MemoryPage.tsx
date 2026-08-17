import { useMemo, useState } from "react";
import { Bot as BotIcon, Brain, Check, Plug, Plus, Search, ShieldCheck, Trash2, User, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { MemoryEntry, MemoryKind, MemorySource, TrustTier } from "@/lib/memory";
import { useStore } from "@/state/store";

// Platform-style segmentation: stat strip, review queue, kind sections with
// plain-language explanations, search + source/tier filters, provenance.

const TIER_META: Record<TrustTier, { label: string; className: string }> = {
  quarantined: { label: "Quarantined", className: "bg-danger/15 text-danger" },
  agent_proposed: { label: "Proposed", className: "bg-warning/15 text-warning" },
  human_confirmed: { label: "Confirmed", className: "bg-accent/15 text-accent" },
  org_ratified: { label: "Ratified", className: "bg-success/15 text-success" },
};

const KIND_META: Record<MemoryKind, { title: string; blurb: string }> = {
  fact: { title: "Facts", blurb: "Things that are true about the workspace" },
  preference: { title: "Preferences", blurb: "How people like things done" },
  procedure: { title: "Procedures", blurb: "How we do things, step by step" },
  episode: { title: "Episodes", blurb: "What happened, for the record" },
  glossary: { title: "Glossary", blurb: "What our words mean" },
  lesson: { title: "Lessons", blurb: "What we learned the hard way" },
};

const KINDS = Object.keys(KIND_META) as MemoryKind[];

const SOURCE_ICON: Record<MemorySource, typeof User> = { human: User, agent: BotIcon, connector: Plug };

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function TierBadge({ tier }: { tier: TrustTier }) {
  const meta = TIER_META[tier];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className)}>{meta.label}</span>
  );
}

function Provenance({ entry }: { entry: MemoryEntry }) {
  const Icon = SOURCE_ICON[entry.source];
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-ink-secondary/80">
      <Icon size={12} />
      {entry.provenance.author}
      {entry.provenance.sessionRef && <span className="text-ink-secondary/50">· {entry.provenance.sessionRef}</span>}
      <span className="tabular-nums text-ink-secondary/50">· {niceWhen(entry.ts)}</span>
    </span>
  );
}

/** P7: which departments see this entry. Admin-only control, org mode only —
 * empty = the whole org; a team = only that team's members (and admins). */
function TeamScopeSelect({ entry }: { entry: MemoryEntry }) {
  const { state, dispatch } = useStore();
  if (!state.org?.orgMode) return null;
  const teams = state.org.teams;
  const isAdmin = state.orgMe?.role === "admin";
  const teamName = teams.find((t) => t.id === entry.teamId)?.name;
  if (!isAdmin) {
    return entry.teamId ? (
      <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">
        {teamName ?? "team-only"}
      </span>
    ) : null;
  }
  return (
    <select
      value={entry.teamId ?? ""}
      onChange={(e) => dispatch({ type: "setMemoryTeam", entryId: entry.id, teamId: e.target.value || null })}
      title="Which department sees this entry"
      className="rounded-lg border border-hairline/60 bg-inset px-1.5 py-0.5 text-[11px] text-ink-secondary outline-none"
    >
      <option value="">Whole org</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          Only {t.name}
        </option>
      ))}
    </select>
  );
}

function EntryCard({ entry }: { entry: MemoryEntry }) {
  const { dispatch } = useStore();
  return (
    <div
      className={cn(
        "rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5",
        entry.status !== "active" && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "flex-1 text-[13.5px] leading-relaxed text-ink",
            entry.status !== "active" && "line-through decoration-ink-secondary/40",
          )}
        >
          {entry.content}
        </span>
        <TierBadge tier={entry.trustTier} />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Provenance entry={entry} />
        {entry.status === "superseded" && <span className="text-[11px] text-ink-secondary/60">superseded</span>}
        {entry.status === "retired" && <span className="text-[11px] text-ink-secondary/60">retired</span>}
        <span className="ml-auto flex items-center gap-1">
          {entry.status === "active" && <TeamScopeSelect entry={entry} />}
          {entry.status === "active" && entry.trustTier === "human_confirmed" && (
            <button
              onClick={() => dispatch({ type: "promoteMemory", entryId: entry.id })}
              title="Promote to org-ratified"
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
            >
              <ShieldCheck size={12} />
              Ratify
            </button>
          )}
          {entry.status === "active" && (
            <button
              onClick={() => dispatch({ type: "retireMemory", entryId: entry.id })}
              title="Retire (kept on record, never used again)"
              className="rounded-lg p-1 text-ink-secondary/70 transition-colors hover:bg-raised hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function ReviewCard({ entry }: { entry: MemoryEntry }) {
  const { dispatch } = useStore();
  return (
    <div className="rounded-xl border border-warning/30 bg-panel px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[13.5px] leading-relaxed text-ink">{entry.content}</span>
        <TierBadge tier={entry.trustTier} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Provenance entry={entry} />
        <span className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => dispatch({ type: "reviewMemory", entryId: entry.id, verdict: "accept" })}
            className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white"
          >
            <Check size={13} />
            Accept
          </button>
          <button
            onClick={() => dispatch({ type: "reviewMemory", entryId: entry.id, verdict: "reject" })}
            className="flex items-center gap-1 rounded-lg border border-hairline/60 bg-inset px-2.5 py-1 text-[12px] text-danger transition-colors hover:bg-danger/10"
          >
            <X size={13} />
            Reject
          </button>
        </span>
      </div>
    </div>
  );
}

function NewMemoryForm({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const field =
    "rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70";
  return (
    <form
      className="mt-3 flex items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!content.trim()) return;
        dispatch({ type: "addMemory", input: { kind, content: content.trim() } });
        setContent("");
        onClose();
      }}
    >
      <input
        autoFocus
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Something worth remembering…"
        className={cn(field, "flex-1")}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className={field}>
        {KINDS.map((value) => (
          <option key={value} value={value}>
            {KIND_META[value].title}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!content.trim()}
        className="rounded-xl bg-accent px-3.5 py-2.5 text-[13px] font-medium text-white disabled:opacity-40"
      >
        Save
      </button>
    </form>
  );
}

type SourceFilter = "all" | MemorySource;
type TierFilter = "all" | TrustTier;

export function MemoryPage() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [tier, setTier] = useState<TierFilter>("all");
  const [adding, setAdding] = useState(false);

  const entries = state.memoryEntries;
  const reviewQueue = useMemo(
    () =>
      entries.filter(
        (entry) => entry.status === "active" && ["quarantined", "agent_proposed"].includes(entry.trustTier),
      ),
    [entries],
  );
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      if (source !== "all" && entry.source !== source) return false;
      if (tier !== "all" && entry.trustTier !== tier) return false;
      if (terms.length && !terms.every((t) => entry.content.toLowerCase().includes(t))) return false;
      return true;
    });
  }, [entries, query, source, tier]);

  const counts = useMemo(() => {
    const active = entries.filter((entry) => entry.status === "active");
    return {
      confirmed: active.filter((entry) => entry.trustTier === "human_confirmed").length,
      ratified: active.filter((entry) => entry.trustTier === "org_ratified").length,
      pending: reviewQueue.length,
      fromAgents: active.filter((entry) => entry.source === "agent").length,
      fromHumans: active.filter((entry) => entry.source === "human").length,
    };
  }, [entries, reviewQueue]);

  const chip = (isActive: boolean) =>
    cn(
      "rounded-lg px-2.5 py-1 text-[12px] transition-colors",
      isActive ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50",
    );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-8 py-8">
          <div className="flex items-center gap-3">
            <div className="text-[17px] font-semibold text-ink">Memory</div>
            <button
              onClick={() => setAdding((v) => !v)}
              className="ml-auto flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised/70"
            >
              <Plus size={13} />
              Add
            </button>
          </div>
          <div className="mt-1 text-[12.5px] text-ink-secondary">
            What the workspace knows. Bots propose; nothing is trusted until a human confirms it.
          </div>
          {adding && <NewMemoryForm onClose={() => setAdding(false)} />}

          {/* stat mini-strip */}
          <div className="mt-4 grid grid-cols-5 gap-2">
            {(
              [
                ["Pending review", counts.pending],
                ["Confirmed", counts.confirmed],
                ["Ratified", counts.ratified],
                ["From bots", counts.fromAgents],
                ["From people", counts.fromHumans],
              ] as Array<[string, number]>
            ).map(([label, value]) => (
              <div key={label} className="rounded-xl border border-hairline/50 bg-panel px-3 py-2.5">
                <div className="text-[18px] font-semibold tabular-nums text-ink">{value}</div>
                <div className="mt-0.5 text-[11px] text-ink-secondary">{label}</div>
              </div>
            ))}
          </div>

          {/* review queue */}
          {reviewQueue.length > 0 && (
            <div className="mt-6">
              <div className="text-[12px] font-medium uppercase tracking-wide text-warning">
                Review queue — waiting for you
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {reviewQueue.map((entry) => (
                  <ReviewCard key={entry.id} entry={entry} />
                ))}
              </div>
            </div>
          )}

          {/* search + filters */}
          <div className="mt-6 flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-hairline/60 bg-inset px-3 py-2">
              <Search size={14} className="text-ink-secondary/60" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search memory…"
                className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(["all", "human", "agent", "connector"] as SourceFilter[]).map((value) => (
              <button key={value} onClick={() => setSource(value)} className={chip(source === value)}>
                {value === "all" ? "Any source" : value === "human" ? "People" : value === "agent" ? "Bots" : "Connectors"}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-hairline/60" />
            {(["all", "quarantined", "agent_proposed", "human_confirmed", "org_ratified"] as TierFilter[]).map((value) => (
              <button key={value} onClick={() => setTier(value)} className={chip(tier === value)}>
                {value === "all" ? "Any tier" : TIER_META[value].label}
              </button>
            ))}
          </div>

          {/* kind sections */}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-ink-secondary">
              <Brain size={22} />
              <div className="text-[14px]">
                {entries.length === 0 ? "Nothing remembered yet." : "Nothing matches those filters."}
              </div>
            </div>
          ) : (
            KINDS.map((kind) => {
              const inKind = filtered.filter((entry) => entry.kind === kind);
              if (inKind.length === 0) return null;
              const meta = KIND_META[kind];
              return (
                <div key={kind} className="mt-6">
                  <div className="flex items-baseline gap-2">
                    <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">{meta.title}</div>
                    <div className="text-[11.5px] text-ink-secondary/60">— {meta.blurb}</div>
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {inKind
                      .slice()
                      .sort((a, b) => b.ts - a.ts)
                      .map((entry) => (
                        <EntryCard key={entry.id} entry={entry} />
                      ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}
