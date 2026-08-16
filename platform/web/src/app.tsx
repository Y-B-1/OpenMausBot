// Atrium web UI — Wave 6: app shell with sidebar IA (Inbox / Channels / Goals /
// Pipelines / Costs / Memory / Computer), chat, approvals, blocking questions,
// goal loops, pipeline runs, cost ledger, memory review, sandbox audit.
// Design: type.com × OpenMausBot cross (docs/platform/research/agentos-video-study.md §4).
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AgentRecord,
  Approval,
  Channel,
  GoalRecord,
  InboxItem,
  MemoryEntry,
  PipelineRun,
  QuestionRecord,
  RoutineRecord,
  TemplateRecord,
  User,
} from "../../shared/contracts.ts";
import { api, enableNotifications, notificationsEnabled, notificationsSupported, useStore, type FeedItem, type PendingTurn, type StateSnapshot } from "./store.tsx";

// ---------- Small pieces ----------

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Avatar({ user, agent }: { user: User | undefined; agent?: AgentRecord | undefined }) {
  const isAgent = agent !== undefined || user?.kind === "agent";
  const name = user?.name ?? agent?.name ?? "?";
  return <span className={`avatar ${isAgent ? "avatar-agent" : "avatar-human"}`}>{initials(name)}</span>;
}

function useNotice(): (err: unknown) => void {
  const { dispatch } = useStore();
  return (err) => dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
}

// ---------- Login ----------

function Login() {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { token, user } = await api<{ token: string; user: User }>(null, "POST", "/api/login", { name: name.trim() });
      dispatch({ a: "login", token, me: user });
      const snap = await api<StateSnapshot>(token, "GET", "/api/state");
      dispatch({ a: "snapshot", snap });
    } catch (e2) {
      setErr(String(e2 instanceof Error ? e2.message : e2));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark">A</div>
        <h1 className="serif">Atrium</h1>
        <p className="login-sub">A shared workspace where your team and your agents work side by side.</p>
        <label className="field-label" htmlFor="login-name">Your name</label>
        <input
          id="login-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Yosri"
        />
        <button type="submit" className="btn btn-cta" disabled={busy || !name.trim()}>
          {busy ? "Signing in…" : "Enter the atrium"}
        </button>
        {err && <p className="error-text">{err}</p>}
      </form>
    </div>
  );
}

// ---------- Sidebar ----------

type View = "inbox" | "channels" | "board" | "goals" | "pipelines" | "costs" | "memory" | "files" | "computer" | "admin";

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const notice = useNotice();

  const openInbox =
    Object.values(state.inbox).filter((i) => i.status === "open").length +
    Object.values(state.questions).filter((q) => q.status === "pending").length;
  const memQueue = Object.values(state.memory).filter(
    (m) => m.status === "active" && (m.trustTier === "quarantined" || m.trustTier === "agent_proposed"),
  ).length;
  const runningGoals = Object.values(state.goals).filter((g) => g.status === "running").length;
  const gatedRuns = Object.values(state.pipelines).filter((p) => p.stepStates.includes("awaiting_approval")).length;

  const createChannel = async (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      const { channel } = await api<{ channel: Channel }>(state.token, "POST", "/api/channels", { name, space: "general" });
      dispatch({ a: "channel-created", channel });
      setView("channels");
      setDraft("");
    } catch (err) {
      notice(err);
    }
  };

  const NavItem = ({ v, label, badge }: { v: View; label: string; badge?: number }) => (
    <button className={`nav-item ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
      <span>{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-badge">{badge}</span>}
    </button>
  );

  return (
    <nav className="rail">
      <div className="rail-org">
        <span className="rail-org-mark">A</span>
        <div>
          <div className="rail-org-name serif">Atrium</div>
          <div className="rail-org-sub mono">org · acme</div>
        </div>
      </div>
      <div className="nav">
        <NavItem v="inbox" label="Inbox" badge={openInbox} />
        <NavItem v="channels" label="Channels" />
        <NavItem v="board" label="Board" />
        <NavItem v="goals" label="Goals" badge={runningGoals} />
        <NavItem v="pipelines" label="Pipelines" badge={gatedRuns} />
        <NavItem v="costs" label="Costs" />
        <NavItem v="memory" label="Memory" badge={memQueue} />
        <NavItem v="files" label="Files" />
        <NavItem v="computer" label="Computer" />
        {state.me?.role === "admin" && <NavItem v="admin" label="Admin" />}
      </div>
      <div className="rail-section-title mono">DIRECT MESSAGES</div>
      <ul className="channel-list dm-list">
        {Object.values(state.agents).map((a) => (
          <li key={a.id}>
            <button
              className={`channel-item ${state.channels.find((c) => c.id === state.currentChannelId)?.space === "dm" && state.channels.find((c) => c.id === state.currentChannelId)?.name === a.name && view === "channels" ? "active" : ""}`}
              onClick={async () => {
                try {
                  const { channel } = await api<{ channel: Channel }>(state.token, "POST", "/api/dm", { agentId: a.id });
                  dispatch({ a: "channel-created", channel });
                  dispatch({ a: "select-channel", channelId: channel.id });
                  setView("channels");
                } catch (err) {
                  notice(err);
                }
              }}
            >
              <span className="dm-dot" /> {a.name}
            </button>
          </li>
        ))}
        {Object.keys(state.agents).length === 0 && <li className="rail-empty">No agents yet.</li>}
      </ul>
      <div className="rail-section-title mono">CHANNELS</div>
      <ul className="channel-list">
        {(() => {
          const spaces = new Map<string, Channel[]>();
          for (const c of state.channels) {
            if (c.space === "dm") continue;
            spaces.set(c.space, [...(spaces.get(c.space) ?? []), c]);
          }
          return [...spaces.entries()].map(([space, chans]) => (
            <li key={space}>
              <div className="rail-space-title mono" data-space={space}>{space}</div>
              <ul className="channel-list">
                {chans.map((c) => (
                  <li key={c.id}>
                    <button
                      className={`channel-item ${state.currentChannelId === c.id && view === "channels" ? "active" : ""}`}
                      onClick={() => {
                        dispatch({ a: "select-channel", channelId: c.id });
                        setView("channels");
                      }}
                    >
                      <span className="channel-hash">#</span> {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ));
        })()}
        {state.channels.filter((c) => c.space !== "dm").length === 0 && <li className="rail-empty">No channels yet.</li>}
      </ul>
      <form className="rail-create" onSubmit={createChannel}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New channel…" aria-label="New channel name" />
        <button type="submit" className="btn btn-ghost" title="Create channel">＋</button>
      </form>
      <div className="rail-foot">
        <span className={`ws-dot ws-${state.wsStatus}`} />
        <span className="mono">{state.wsStatus}</span>
      </div>
    </nav>
  );
}

// ---------- Page scaffold ----------

function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <h2 className="serif">{title}</h2>
        {sub && <p className="page-sub">{sub}</p>}
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

// ---------- Inbox view (W6-A) ----------

function QuestionCard({ question }: { question: QuestionRecord }) {
  const { state } = useStore();
  const notice = useNotice();
  const [free, setFree] = useState("");
  const agent = state.agents[question.agentId];

  const answer = async (value: string) => {
    if (!value.trim()) return;
    try {
      await api(state.token, "POST", `/api/questions/${question.id}/answer`, { answer: value });
    } catch (err) {
      notice(err);
    }
  };

  return (
    <div className={`card question-card ${question.status}`} data-testid="question-card">
      <div className="card-head">
        <span className="chip chip-question">Question</span>
        <span className="card-actor">{agent?.name ?? question.agentId}</span>
        {question.status === "answered" && <span className="chip chip-done">answered</span>}
      </div>
      <div className="card-text">{question.prompt}</div>
      {question.status === "pending" ? (
        question.options.length > 0 ? (
          <div className="option-row">
            {question.options.map((opt) => (
              <button key={opt} className="btn btn-option" onClick={() => answer(opt)}>
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void answer(free);
            }}
          >
            <input value={free} onChange={(e) => setFree(e.target.value)} placeholder="Type your answer…" aria-label="Answer" />
            <button type="submit" className="btn btn-primary" disabled={!free.trim()}>Answer</button>
          </form>
        )
      ) : (
        <div className="card-foot mono">answered · {question.answer}</div>
      )}
    </div>
  );
}

function InboxView({ goTo }: { goTo: (v: View) => void }) {
  const { state, dispatch } = useStore();
  const openRoom = (channelId?: string) => {
    if (!channelId) return;
    dispatch({ a: "select-channel", channelId });
    goTo("channels");
  };
  const notice = useNotice();
  const [replies, setReplies] = useState<Record<string, string>>({});
  const questions = Object.values(state.questions).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1));
  const items = Object.values(state.inbox).sort((a, b) => b.ts - a.ts);

  const reply = async (item: InboxItem) => {
    const text = (replies[item.id] ?? "").trim();
    if (!text) return;
    try {
      await api(state.token, "POST", `/api/inbox/${item.id}/reply`, { reply: text });
      setReplies({ ...replies, [item.id]: "" });
    } catch (err) {
      notice(err);
    }
  };

  const [notifyOn, setNotifyOn] = useState(notificationsEnabled());
  const askNotify = async () => setNotifyOn(await enableNotifications());

  return (
    <Page title="Inbox" sub="Agents reach you here — and only here. Reply to resume their work.">
      {notificationsSupported() && !notifyOn && (
        <button className="btn btn-ghost notify-enable" data-testid="notify-enable" onClick={askNotify}>
          Enable desktop notifications
        </button>
      )}
      {questions.filter((q) => q.status === "pending").length === 0 && items.length === 0 && (
        <div className="empty-state">
          <div className="empty-title serif">All quiet</div>
          <p>No agent needs you right now. Questions and status updates land here.</p>
        </div>
      )}
      {questions.map((q) => (
        <div key={q.id} className="mem-wrap">
          <QuestionCard question={q} />
          <div className="mem-source">
            <button className="btn btn-ghost btn-open-room" onClick={() => openRoom(q.channelId)}>Open the room this came from →</button>
          </div>
        </div>
      ))}
      {items.map((item) => {
        const agent = state.agents[item.agentId];
        return (
          <div key={item.id} className={`card inbox-card ${item.status}`} data-testid="inbox-card">
            <div className="card-head">
              <Avatar user={state.roster[item.agentId]} agent={agent} />
              <span className="card-actor">{agent?.name ?? item.agentId}</span>
              <span className="card-ts mono">{new Date(item.ts).toLocaleString()}</span>
              <span className={`chip ${item.status === "open" ? "chip-open" : "chip-done"}`}>{item.status}</span>
            </div>
            <div className="card-text">{item.text}</div>
            {item.status === "open" ? (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void reply(item);
                }}
              >
                <input
                  value={replies[item.id] ?? ""}
                  onChange={(e) => setReplies({ ...replies, [item.id]: e.target.value })}
                  placeholder="Reply…"
                  aria-label="Reply"
                />
                <button type="submit" className="btn btn-primary" disabled={!(replies[item.id] ?? "").trim()}>Reply</button>
              </form>
            ) : (
              <div className="card-foot mono">you replied · {item.reply}</div>
            )}
            {item.channelId && (
              <div className="card-actions">
                <button className="btn btn-ghost btn-open-room" onClick={() => openRoom(item.channelId)}>Open the room this came from →</button>
              </div>
            )}
          </div>
        );
      })}
    </Page>
  );
}

// ---------- Goals view (W6-B) ----------

function GoalCard({ goal }: { goal: GoalRecord }) {
  const { state } = useStore();
  const agent = state.agents[goal.agentId];
  const done = goal.criteria.filter((c) => c.done).length;
  const pct = goal.criteria.length > 0 ? Math.round((done / goal.criteria.length) * 100) : 0;
  return (
    <div className={`card goal-card goal-${goal.status}`} data-testid="goal-card">
      <div className="card-head">
        <span className="goal-name">{goal.name}</span>
        <span className={`chip chip-status-${goal.status}`}>{goal.status}</span>
        <span className="card-ts mono">
          {done}/{goal.criteria.length} · {goal.sessions} sessions · ${goal.spentUsd.toFixed(4)}
        </span>
      </div>
      <div className="progress">
        <div className="progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <ul className="criteria">
        {goal.criteria.map((c) => (
          <li key={c.id} className={c.done ? "done" : ""}>
            <span className="crit-mark">{c.done ? "✓" : "○"}</span> {c.text}
          </li>
        ))}
      </ul>
      <div className="card-foot mono">
        @{agent?.name ?? goal.agentId} · caps: {goal.guardrails.maxSessions} sessions · ${goal.guardrails.spendCapUsd} ·{" "}
        {goal.guardrails.wallClockMinutes}m wall · stuck×{goal.guardrails.stuckThreshold}
        {goal.haltReason && <span className="halt-reason"> · halted: {goal.haltReason}</span>}
      </div>
    </div>
  );
}

function GoalsView({ initialChannelId }: { initialChannelId?: string | null }) {
  const { state } = useStore();
  const notice = useNotice();
  const [name, setName] = useState("");
  const [criteria, setCriteria] = useState("");
  const [agentId, setAgentId] = useState("");
  const [channelId, setChannelId] = useState(initialChannelId ?? "");
  const [spendCap, setSpendCap] = useState("25");
  const [maxSessions, setMaxSessions] = useState("20");
  const [stuck, setStuck] = useState("3");
  const agents = Object.values(state.agents);
  const goals = Object.values(state.goals).sort((a, b) => b.startedAt - a.startedAt);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const lines = criteria.split("\n").map((l) => l.trim()).filter(Boolean);
    const agent = agentId || agents[0]?.id;
    const channel = channelId || state.channels[0]?.id;
    if (!name.trim() || lines.length === 0 || !agent || !channel) return;
    try {
      await api(state.token, "POST", "/api/goals", {
        name: name.trim(),
        spec: "",
        criteria: lines,
        agentId: agent,
        channelId: channel,
        guardrails: { spendCapUsd: Number(spendCap), maxSessions: Number(maxSessions), stuckThreshold: Number(stuck) },
      });
      setName("");
      setCriteria("");
    } catch (err) {
      notice(err);
    }
  };

  return (
    <Page title="Goals" sub="Definition-of-done loops. The orchestrator keeps sessions going until every box ticks — or a guardrail stops it.">
      <form className="card form-card" onSubmit={create}>
        <div className="form-grid">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Goal name" aria-label="Goal name" />
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Goal agent">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>@{a.name}</option>
            ))}
          </select>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Goal channel">
            {state.channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          placeholder={"Definition of done — one criterion per line"}
          rows={3}
          aria-label="Criteria"
        />
        <div className="form-grid guardrail-grid">
          <label className="mini-field">
            <span className="mono">spend cap $</span>
            <input value={spendCap} onChange={(e) => setSpendCap(e.target.value)} aria-label="Spend cap" />
          </label>
          <label className="mini-field">
            <span className="mono">max sessions</span>
            <input value={maxSessions} onChange={(e) => setMaxSessions(e.target.value)} aria-label="Max sessions" />
          </label>
          <label className="mini-field">
            <span className="mono">stuck limit</span>
            <input value={stuck} onChange={(e) => setStuck(e.target.value)} aria-label="Stuck threshold" />
          </label>
          <button type="submit" className="btn btn-cta" disabled={!name.trim() || !criteria.trim() || agents.length === 0}>
            Start goal
          </button>
        </div>
      </form>
      {goals.length === 0 && (
        <div className="empty-state">
          <div className="empty-title serif">No goals yet</div>
          <p>Write a definition of done and let the loop run. Every guardrail is a hard stop.</p>
        </div>
      )}
      {goals.map((g) => (
        <GoalCard key={g.id} goal={g} />
      ))}
    </Page>
  );
}

// ---------- Pipelines view (W6-C) ----------

function PipelineCard({ run }: { run: PipelineRun }) {
  const { state } = useStore();
  const notice = useNotice();
  const template = state.templates[run.templateId];
  const advance = async () => {
    try {
      await api(state.token, "POST", `/api/pipelines/${run.id}/advance`);
    } catch (err) {
      notice(err);
    }
  };
  const gated = run.stepStates.includes("awaiting_approval");
  return (
    <div className="card pipeline-card" data-testid="pipeline-card">
      <div className="card-head">
        <span className="goal-name">{run.name}</span>
        <span className={`chip chip-status-${run.status === "done" ? "done" : gated ? "gated" : "running"}`}>
          {run.status === "done" ? "done" : gated ? "awaiting approval" : "running"}
        </span>
      </div>
      {run.input && <div className="card-text">{run.input}</div>}
      <ol className="pipe-steps">
        {(template?.steps ?? []).map((s, i) => (
          <li key={i} className={`pipe-step pipe-${run.stepStates[i] ?? "pending"}`}>
            <span className="pipe-state mono">{run.stepStates[i] ?? "pending"}</span>
            <span className="pipe-title">{s.title}</span>
            <span className="pipe-agent mono">@{state.agents[s.agentId]?.name ?? "?"}</span>
            {s.requiresApproval && <span className="chip chip-gate">gate</span>}
          </li>
        ))}
      </ol>
      {gated && (
        <div className="card-actions">
          <button className="btn btn-cta" onClick={advance}>Approve &amp; continue</button>
        </div>
      )}
    </div>
  );
}

function PipelinesView() {
  const { state, dispatch } = useStore();
  const notice = useNotice();
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("Write spec | Produce a spec for the input. | gate\nImplement | Implement the spec.");
  const [templateId, setTemplateId] = useState("");
  const [input, setInput] = useState("");
  const [channelId, setChannelId] = useState("");
  const agents = Object.values(state.agents);
  const templates = Object.values(state.templates);
  const runs = Object.values(state.pipelines);

  const createTemplate = async (e: FormEvent) => {
    e.preventDefault();
    const agent = agents[0];
    if (!name.trim() || !agent) return;
    const parsed = steps
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [title = "step", prompt = "", flag = ""] = line.split("|").map((p) => p.trim());
        return { title, prompt, agentId: agent.id, requiresApproval: /gate/i.test(flag) };
      });
    if (parsed.length === 0) return;
    try {
      await api(state.token, "POST", "/api/templates", { name: name.trim(), steps: parsed });
      // TemplateCreated carries no channelId, so it never fans out over WS —
      // refresh the snapshot so the "start run" select sees the new template.
      const snap = await api<StateSnapshot>(state.token, "GET", "/api/state");
      dispatch({ a: "snapshot", snap });
      setName("");
    } catch (err) {
      notice(err);
    }
  };

  const startRun = async (e: FormEvent) => {
    e.preventDefault();
    const template = templateId || templates[0]?.id;
    const channel = channelId || state.channels[0]?.id;
    if (!template || !channel) return;
    try {
      await api(state.token, "POST", "/api/pipelines", { templateId: template, channelId: channel, input });
      setInput("");
    } catch (err) {
      notice(err);
    }
  };

  return (
    <Page title="Pipelines" sub="Chained steps with human approval gates. Mark a step done and the next one starts itself.">
      <div className="two-col">
        <form className="card form-card" onSubmit={createTemplate}>
          <div className="form-title mono">NEW TEMPLATE</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" aria-label="Template name" />
          <textarea
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            rows={4}
            aria-label="Steps"
            placeholder={"One step per line: Title | Prompt | gate"}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || agents.length === 0}>Create template</button>
        </form>
        <form className="card form-card" onSubmit={startRun}>
          <div className="form-title mono">START RUN</div>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Channel">
            {state.channels.map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Input for the run" aria-label="Run input" />
          <button type="submit" className="btn btn-cta" disabled={templates.length === 0 || state.channels.length === 0}>Start run</button>
        </form>
      </div>
      {runs.length === 0 && (
        <div className="empty-state">
          <div className="empty-title serif">No runs yet</div>
          <p>Create a template — spec, plan, review, implement — then feed it work.</p>
        </div>
      )}
      {runs.map((r) => (
        <PipelineCard key={r.id} run={r} />
      ))}
    </Page>
  );
}

// ---------- Board view (E1): everything in flight, kanban-style ----------

type BoardCard = { id: string; title: string; kind: "goal" | "pipeline"; meta: string };

function BoardView({ goTo }: { goTo: (v: View) => void }) {
  const { state } = useStore();
  const cards: Record<"todo" | "doing" | "review" | "done", BoardCard[]> = { todo: [], doing: [], review: [], done: [] };
  for (const g of Object.values(state.goals)) {
    const done = g.criteria.filter((c) => c.done).length;
    const card: BoardCard = { id: g.id, title: g.name, kind: "goal", meta: `${done}/${g.criteria.length} criteria · $${g.spentUsd.toFixed(4)}` };
    if (g.status === "done") cards.done.push(card);
    else if (g.status === "halted") cards.review.push({ ...card, meta: `halted: ${g.haltReason ?? "needs attention"}` });
    else if (g.sessions === 0) cards.todo.push(card);
    else cards.doing.push(card);
  }
  for (const p of Object.values(state.pipelines)) {
    const template = state.templates[p.templateId];
    const step = template?.steps[p.stepIndex]?.title ?? "";
    const card: BoardCard = { id: p.id, title: p.name, kind: "pipeline", meta: step ? `step: ${step}` : "" };
    if (p.status === "done") cards.done.push(card);
    else if (p.stepStates.includes("awaiting_approval")) cards.review.push({ ...card, meta: `waiting for your approval · ${step}` });
    else cards.doing.push(card);
  }
  const COLS = [
    { key: "todo", label: "To do" },
    { key: "doing", label: "Doing" },
    { key: "review", label: "Needs you" },
    { key: "done", label: "Done" },
  ] as const;
  return (
    <Page title="Board" sub="Everything in flight, at a glance. 'Needs you' is the only column that can't move without you.">
      <div className="board">
        {COLS.map((col) => (
          <div key={col.key} className="board-col">
            <div className="board-col-title mono">{col.label} · {cards[col.key].length}</div>
            {cards[col.key].map((c) => (
              <button key={c.id} className="board-card" onClick={() => goTo(c.kind === "goal" ? "goals" : "pipelines")}>
                <span className={`chip ${c.kind === "goal" ? "chip-question" : "chip-gate"}`}>{c.kind}</span>
                <span className="board-card-title">{c.title}</span>
                <span className="board-card-meta mono">{c.meta}</span>
              </button>
            ))}
            {cards[col.key].length === 0 && <div className="panel-empty">Empty.</div>}
          </div>
        ))}
      </div>
    </Page>
  );
}

// ---------- Costs view (W6-E) ----------

function CostsView() {
  const { state } = useStore();
  const total = state.costs.reduce((n, c) => n + c.estUsd, 0);
  const byAgent = new Map<string, { turns: number; usd: number }>();
  for (const c of state.costs) {
    const row = byAgent.get(c.agentId) ?? { turns: 0, usd: 0 };
    row.turns += 1;
    row.usd += c.estUsd;
    byAgent.set(c.agentId, row);
  }
  return (
    <Page title="Costs" sub="Estimated spend per agent turn. Goal guardrails read the same ledger.">
      <div className="stat-row">
        <div className="card stat-card">
          <div className="stat-value serif">${total.toFixed(4)}</div>
          <div className="stat-label mono">estimated total</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value serif">{state.costs.length}</div>
          <div className="stat-label mono">agent turns</div>
        </div>
      </div>
      {byAgent.size > 0 && (
        <div className="card">
          <table className="cost-table">
            <thead>
              <tr><th>agent</th><th>turns</th><th>est. spend</th></tr>
            </thead>
            <tbody>
              {[...byAgent.entries()].map(([agentId, row]) => (
                <tr key={agentId}>
                  <td>{state.roster[agentId]?.name ?? agentId}</td>
                  <td className="mono">{row.turns}</td>
                  <td className="mono">${row.usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="page-note">
        <a className="mono" href="/api/export" target="_blank" rel="noreferrer">Export org config as YAML →</a>
      </div>
    </Page>
  );
}

// ---------- Memory + Computer views (existing panels, promoted to pages) ----------

const TIER_LABEL: Record<string, string> = {
  quarantined: "quarantined",
  agent_proposed: "agent proposed",
  human_confirmed: "human confirmed",
  org_ratified: "org ratified",
};

function MemoryCard({ entry, reviewable }: { entry: MemoryEntry; reviewable: boolean }) {
  const { state, dispatch } = useStore();
  const notice = useNotice();
  const author = state.roster[entry.provenance.author];
  const review = async (accept: boolean) => {
    try {
      await api(state.token, "POST", `/api/memory/${entry.id}/review`, { accept });
      dispatch({ a: "memory-reviewed", entryId: entry.id, accepted: accept });
    } catch (err) {
      notice(err);
    }
  };
  return (
    <div className="card mem-card">
      <div className="card-text">{entry.content}</div>
      <div className="mem-meta mono">
        <span className="tag">{entry.scope}</span>
        <span className="tag">{entry.kind}</span>
        <span className={`tag tag-tier-${entry.trustTier}`}>{TIER_LABEL[entry.trustTier] ?? entry.trustTier}</span>
      </div>
      <div className="card-foot mono">by {author?.name ?? entry.provenance.author} · session {entry.provenance.sessionRef.slice(0, 8)}</div>
      {reviewable && (
        <div className="card-actions">
          <button className="btn btn-primary" onClick={() => review(true)}>Accept</button>
          <button className="btn btn-danger" onClick={() => review(false)}>Reject</button>
        </div>
      )}
    </div>
  );
}

const SCOPE_TABS = [
  { key: "org", label: "Organization" },
  { key: "space", label: "Team" },
  { key: "personal", label: "Personal" },
] as const;

function MemoryView() {
  const { state } = useStore();
  const [scope, setScope] = useState<"org" | "space" | "personal">("org");
  const entries = Object.values(state.memory).filter((m) => m.status === "active");
  // Only what AGENTS claim to have learned needs a human's yes. Connector
  // syncs and human notes are trusted at the source.
  const queue = entries.filter(
    (m) => (m.source ?? "agent") === "agent" && (m.trustTier === "quarantined" || m.trustTier === "agent_proposed"),
  );
  const accepted = entries.filter((m) => m.trustTier === "human_confirmed" || m.trustTier === "org_ratified");
  const inScope = accepted.filter((m) => m.scope === scope);
  const teamName = (id?: string) => (id ? state.teams[id]?.name ?? "team" : null);
  return (
    <Page
      title="Memory"
      sub="Three shelves: organization, team, personal. Agent proposals wait for your approval; connector-synced facts arrive pre-trusted."
    >
      <div className="section-title mono">AGENT PROPOSALS AWAITING YOUR REVIEW ({queue.length})</div>
      {queue.length === 0 && <div className="empty-state"><p>No agent proposals waiting. Connector syncs never appear here — they are trusted at the source.</p></div>}
      {queue.map((m) => (
        <MemoryCard key={m.id} entry={m} reviewable />
      ))}
      <div className="section-title mono">ACCEPTED MEMORY</div>
      <div className="tab-row">
        {SCOPE_TABS.map((t) => (
          <button key={t.key} className={`btn btn-option ${scope === t.key ? "tab-active" : ""}`} onClick={() => setScope(t.key)}>
            {t.label} ({accepted.filter((m) => m.scope === t.key).length})
          </button>
        ))}
      </div>
      {inScope.length === 0 && <div className="empty-state"><p>Nothing on this shelf yet.</p></div>}
      {inScope.map((m) => (
        <div key={m.id} className="mem-wrap">
          <MemoryCard entry={m} reviewable={false} />
          <div className="mem-source mono">
            <span className={`chip chip-src-${m.source ?? "agent"}`}>
              {m.source === "connector" ? `synced · ${state.connectors[m.provenance.author]?.name ?? "connector"}` : m.source === "human" ? "human-written" : "agent-learned"}
            </span>
            {m.teamId && <span className="chip">{teamName(m.teamId)}</span>}
          </div>
        </div>
      ))}
    </Page>
  );
}

// ---------- Admin view (E2/E3) ----------

type AuditRow = { id: string; kind: number; authorId: string; ts: number; channelId?: string };

const KIND_LABEL: Record<number, string> = {
  1: "message",
  10: "channel created",
  11: "member added",
  20: "agent turn started",
  22: "agent turn completed",
  30: "approval requested",
  31: "approval resolved",
  40: "memory proposed",
  41: "memory accepted",
  42: "memory rejected",
  50: "sandbox exec",
  61: "query plan executed",
  70: "routine created",
  71: "routine run started",
  72: "routine run completed",
  80: "inbox posted",
  81: "inbox replied",
  82: "question asked",
  83: "question answered",
  90: "goal created",
  91: "goal session started",
  92: "goal session completed",
  93: "criterion checked",
  94: "goal completed",
  95: "goal halted",
  100: "template created",
  101: "pipeline started",
  102: "pipeline step started",
  103: "pipeline step completed",
  104: "pipeline completed",
  110: "file written",
  111: "egress denied",
  120: "turn cost recorded",
  130: "team created",
  131: "team member added",
  132: "role changed",
  140: "connector created",
  141: "connector updated",
  142: "connector synced",
};

function AdminView() {
  const { state, dispatch } = useStore();
  const notice = useNotice();
  const [tab, setTab] = useState<"people" | "connectors" | "providers" | "audit">("people");
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [teamName, setTeamName] = useState("");
  const [provider, setProvider] = useState("sharepoint");
  const [kind, setKind] = useState<"memory" | "agent">("memory");
  const [scope, setScope] = useState<"org" | "team">("org");
  const [teamId, setTeamId] = useState("");
  const humans = Object.values(state.roster).filter((u) => u.kind === "human" && u.id !== "routine" && u.id !== "orchestrator");
  const teams = Object.values(state.teams);
  const connectors = Object.values(state.connectors);

  // Org-level events (roles, teams, connectors, syncs) have no channelId and
  // never fan out over WS — refresh the snapshot on mount and after each call.
  const refresh = async () => {
    const snap = await api<StateSnapshot>(state.token, "GET", "/api/state");
    dispatch({ a: "snapshot", snap });
  };
  useEffect(() => {
    refresh().catch(notice);
  }, []);

  const call = async (path: string, body: unknown = {}) => {
    try {
      await api(state.token, "POST", path, body);
      await refresh();
    } catch (err) {
      notice(err);
    }
  };

  useEffect(() => {
    if (tab !== "audit") return;
    api<{ events: AuditRow[] }>(state.token, "GET", "/api/audit")
      .then((r) => setAudit(r.events))
      .catch(notice);
  }, [tab]);

  return (
    <Page title="Admin" sub="People, teams, and the org's connectors. Only admins see this room.">
      <div className="tab-row">
        <button className={`btn btn-option ${tab === "people" ? "tab-active" : ""}`} onClick={() => setTab("people")}>People &amp; Teams</button>
        <button className={`btn btn-option ${tab === "connectors" ? "tab-active" : ""}`} onClick={() => setTab("connectors")}>Connectors</button>
        <button className={`btn btn-option ${tab === "providers" ? "tab-active" : ""}`} onClick={() => setTab("providers")}>Model providers</button>
        <button className={`btn btn-option ${tab === "audit" ? "tab-active" : ""}`} onClick={() => setTab("audit")}>Audit</button>
      </div>

      {tab === "audit" && (
        <div className="card">
          <div className="form-title mono">LAST {audit.length} EVENTS</div>
          {audit.length === 0 && <div className="panel-empty">No events yet.</div>}
          {[...audit].reverse().map((e) => (
            <div key={e.id} className="admin-row" data-testid="audit-row">
              <span className="chip mono">{e.kind}</span>
              <span className="roster-name">{KIND_LABEL[e.kind] ?? "event"}</span>
              <span className="card-actor">{state.roster[e.authorId]?.name ?? e.authorId}</span>
              <span className="card-ts mono">{new Date(e.ts).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "providers" && (
        <>
          {state.providers.map((p) => (
            <div key={p.id} className="card" data-testid="provider-card">
              <div className="card-head">
                <span className="goal-name">{p.label}</span>
                <span className={`chip ${p.ready ? "chip-done" : "chip-status-halted"}`}>{p.ready ? "key present — live" : "key missing"}</span>
              </div>
              <div className="card-text">{p.enables}</div>
              <div className="card-foot mono">
                {p.requires.map((r) => (
                  <span key={r} className={`chip ${p.present.includes(r) ? "chip-done" : ""}`} style={{ marginRight: 6 }}>
                    {r} {p.present.includes(r) ? "✓" : "· not set"}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <div className="empty-state">
            <p>
              To add a key: put the variable in <code className="mono">platform/.env</code> (or the server shell) and restart the
              server. Keys never reach the browser — this page only shows which names are set.
            </p>
          </div>
        </>
      )}

      {tab === "people" && (
        <>
          <div className="card">
            <div className="form-title mono">PEOPLE</div>
            {humans.map((u) => (
              <div key={u.id} className="admin-row">
                <Avatar user={u} />
                <span className="roster-name">{u.name}</span>
                <span className={`chip ${u.role === "admin" ? "chip-question" : ""}`}>{u.role ?? "member"}</span>
                {u.role !== "admin" && (
                  <button className="btn btn-ghost" onClick={() => call(`/api/users/${u.id}/role`, { role: "admin" })}>
                    Make admin
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="card form-card">
            <div className="form-title mono">TEAMS</div>
            {teams.map((t) => (
              <div key={t.id} className="admin-row">
                <span className="goal-name">{t.name}</span>
                <span className="chip">{t.memberIds.length} member{t.memberIds.length === 1 ? "" : "s"}</span>
                <select
                  aria-label={`Add member to ${t.name}`}
                  value=""
                  onChange={(e) => e.target.value && call(`/api/teams/${t.id}/members`, { userId: e.target.value })}
                >
                  <option value="">Add member…</option>
                  {humans.filter((u) => !t.memberIds.includes(u.id)).map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
            ))}
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (teamName.trim()) void call("/api/teams", { name: teamName.trim() }).then(() => setTeamName(""));
              }}
            >
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name…" aria-label="New team" />
              <button type="submit" className="btn btn-primary" disabled={!teamName.trim()}>Create team</button>
            </form>
          </div>
        </>
      )}

      {tab === "connectors" && (
        <>
          <div className="card form-card">
            <div className="form-title mono">ADD CONNECTOR</div>
            <div className="form-grid">
              <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
                {["sharepoint", "onedrive", "teams", "outlook", "confluence", "jira", "databricks", "github"].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <select value={kind} onChange={(e) => setKind(e.target.value === "agent" ? "agent" : "memory")} aria-label="Connector kind">
                <option value="memory">feeds memory (read-only)</option>
                <option value="agent">agent tool (read / write-no-delete)</option>
              </select>
              <select value={scope} onChange={(e) => setScope(e.target.value === "team" ? "team" : "org")} aria-label="Connector scope">
                <option value="org">whole organization</option>
                <option value="team">one team</option>
              </select>
              {scope === "team" && (
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Connector team">
                  <option value="">pick team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
              <button
                className="btn btn-cta"
                onClick={() =>
                  call("/api/connectors", {
                    provider,
                    kind,
                    scope,
                    ...(scope === "team" && teamId ? { teamId } : {}),
                    ...(kind === "agent" ? { accessLevel: "write_no_delete" } : {}),
                  })
                }
              >
                Add
              </button>
            </div>
          </div>
          {connectors.length === 0 && (
            <div className="empty-state">
              <div className="empty-title serif">No connectors yet</div>
              <p>Connect SharePoint or Confluence to start filling the organization's memory.</p>
            </div>
          )}
          {connectors.map((c) => (
            <div key={c.id} className="card" data-testid="connector-card">
              <div className="card-head">
                <span className="goal-name">{c.name}</span>
                <span className={`chip ${c.kind === "memory" ? "chip-question" : "chip-gate"}`}>{c.kind === "memory" ? "memory source" : "agent tool"}</span>
                <span className="chip">{c.accessLevel === "read_only" ? "read-only" : "write, no delete"}</span>
                <span className="chip">{c.scope === "team" ? `team · ${state.teams[c.teamId ?? ""]?.name ?? "?"}` : c.scope}</span>
                <span className={`chip ${c.status === "connected" ? "chip-done" : "chip-status-halted"}`}>{c.status}</span>
              </div>
              <div className="option-row">
                {c.tools.map((t) => (
                  <button
                    key={t.name}
                    className={`btn btn-option tool-toggle ${t.enabled ? "tab-active" : "tool-off"}`}
                    title={t.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                    onClick={() =>
                      call(`/api/connectors/${c.id}`, {
                        tools: c.tools.map((x) => (x.name === t.name ? { ...x, enabled: !x.enabled } : x)),
                      })
                    }
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <div className="card-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => call(`/api/connectors/${c.id}`, { status: c.status === "connected" ? "disconnected" : "connected" })}
                >
                  {c.status === "connected" ? "Disconnect" : "Connect"}
                </button>
                {c.kind === "memory" && (
                  <button className="btn btn-primary" disabled={c.status !== "connected"} onClick={() => call(`/api/connectors/${c.id}/sync`)}>
                    Sync now
                  </button>
                )}
                <span className="card-foot mono">
                  {c.syncedCount > 0 ? `${c.syncedCount} items in memory · last sync ${c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleTimeString() : "—"}` : "nothing synced yet"}
                </span>
              </div>
            </div>
          ))}
        </>
      )}
    </Page>
  );
}

// ---------- Files view (E6 doc surface) ----------

type FileRow = { agentId: string; name: string; bytes: number; ts: number };

function FilesView() {
  const { state } = useStore();
  const notice = useNotice();
  const [files, setFiles] = useState<FileRow[]>([]);

  useEffect(() => {
    api<{ files: FileRow[] }>(state.token, "GET", "/api/files")
      .then((r) => setFiles(r.files))
      .catch(notice);
  }, []);

  const byAgent = new Map<string, FileRow[]>();
  for (const f of files) byAgent.set(f.agentId, [...(byAgent.get(f.agentId) ?? []), f]);

  return (
    <Page title="Files" sub="Documents agents have produced, grouped by author.">
      {files.length === 0 && (
        <div className="panel-empty">
          No files yet. Agents write files from their sandbox — ask one to “save file notes.md …” in a channel.
        </div>
      )}
      {[...byAgent.entries()].map(([agentId, rows]) => (
        <div key={agentId} className="card">
          <div className="form-title mono">{state.roster[agentId]?.name ?? agentId} · {rows.length}</div>
          {rows.map((f, i) => (
            <div key={`${f.name}-${f.ts}-${i}`} className="admin-row" data-testid="file-row">
              <span className="roster-name mono">{f.name}</span>
              <span className="chip mono">{f.bytes} B</span>
              <span className="card-ts mono">{new Date(f.ts).toLocaleString()}</span>
            </div>
          ))}
        </div>
      ))}
    </Page>
  );
}

function ComputerView() {
  const { state } = useStore();
  const byAgent = new Map<string, typeof state.sandboxEvents>();
  for (const ev of state.sandboxEvents) {
    const list = byAgent.get(ev.agentId) ?? [];
    list.push(ev);
    byAgent.set(ev.agentId, list);
  }
  return (
    <Page title="Computer" sub="Every sandbox execution, audited. Agents run only what their environment allows.">
      {byAgent.size === 0 && <div className="empty-state"><p>No sandbox executions yet.</p></div>}
      {[...byAgent.entries()].map(([agentId, evs]) => (
        <div key={agentId} className="card">
          <div className="mem-group-title mono">
            {state.roster[agentId]?.name ?? agentId} · {evs.length} exec{evs.length === 1 ? "" : "s"}
          </div>
          {evs.map((ev) => (
            <div key={ev.eventId} className="exec-card">
              <div className="mono exec-argv">$ {ev.argv.join(" ")}</div>
              <div className="mono exec-exit">
                exit <span className={ev.exitCode === 0 ? "exit-ok" : "exit-bad"}>{ev.exitCode}</span>
              </div>
              {ev.stdout && <pre className="mono exec-stdout">{ev.stdout.slice(0, 400)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </Page>
  );
}

// ---------- Chat (channels view) ----------

function ApprovalCard({ approval }: { approval: Approval }) {
  const { state } = useStore();
  const notice = useNotice();
  const agent = state.agents[approval.agentId];
  const respond = async (approve: boolean) => {
    try {
      await api(state.token, "POST", `/api/approvals/${approval.id}`, { approve });
    } catch (err) {
      notice(err);
    }
  };
  return (
    <div className={`card approval-card approval-${approval.status}`}>
      <div className="card-head">
        <span className="chip chip-gate">Approval</span>
        <span className="card-actor">{agent?.name ?? approval.agentId}</span>
        <span className={`chip chip-status-${approval.status === "approved" ? "done" : approval.status === "denied" ? "halted" : "gated"}`}>
          {approval.status}
        </span>
      </div>
      <div className="card-text">
        wants to run <code className="mono">{approval.tool}</code>
      </div>
      <pre className="mono approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
      {approval.status === "pending" && (
        <div className="card-actions">
          <button className="btn btn-primary" onClick={() => respond(true)}>Approve</button>
          <button className="btn btn-danger" onClick={() => respond(false)}>Deny</button>
        </div>
      )}
    </div>
  );
}

function PlanCard({ item }: { item: Extract<FeedItem, { t: "plan" }> }) {
  const { state } = useStore();
  const agent = state.agents[item.authorId];
  const cols = item.resultPreview.length > 0 ? Object.keys(item.resultPreview[0]!) : [];
  return (
    <div className="card plan-card" data-testid="plan-card">
      <div className="card-head">
        <span className="chip chip-question">Query plan</span>
        <span className="card-actor">{agent?.name ?? item.authorId}</span>
      </div>
      <ol className="plan-steps">
        {item.plan.map((step, i) => (
          <li key={i}>{step.replace(/^\d+\.\s*/, "")}</li>
        ))}
      </ol>
      <div className="plan-sql mono">{item.sql_like}</div>
      {cols.length > 0 && (
        <table className="plan-table mono">
          <thead>
            <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {item.resultPreview.map((row, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}>{typeof row[c] === "number" ? (row[c] as number).toLocaleString("en-US") : row[c]}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Composer({ channel }: { channel: Channel }) {
  const { state } = useStore();
  const notice = useNotice();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const channelAgents = useMemo(
    () => channel.memberIds.map((id) => state.agents[id]).filter((a): a is AgentRecord => !!a),
    [channel.memberIds, state.agents],
  );

  const mentionMatch = /(?:^|\s)@(\w*)$/.exec(text);
  const suggestions = mentionMatch
    ? channelAgents.filter((a) => a.name.toLowerCase().startsWith(mentionMatch[1]!.toLowerCase()))
    : [];

  const pick = (name: string) => {
    setText(text.replace(/@\w*$/, `@${name} `));
    inputRef.current?.focus();
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      await api(state.token, "POST", `/api/channels/${channel.id}/messages`, { text: t });
    } catch (err) {
      notice(err);
    }
  };

  return (
    <form className="composer" onSubmit={send}>
      {suggestions.length > 0 && (
        <div className="mention-pop">
          {suggestions.map((a) => (
            <button type="button" key={a.id} className="mention-item" onClick={() => pick(a.name)}>
              <Avatar user={state.roster[a.id]} agent={a} />
              <span>@{a.name}</span>
              <span className="mono mention-driver">{a.driver}</span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Message #${channel.name} — @ to mention an agent`}
        aria-label="Message"
      />
      <button type="submit" className="btn btn-cta" disabled={!text.trim()}>Send</button>
    </form>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const { state } = useStore();
  if (item.t === "approval") {
    const ap = state.approvals[item.approvalId];
    return ap ? <ApprovalCard approval={ap} /> : null;
  }
  if (item.t === "question") {
    const q = state.questions[item.questionId];
    return q ? <QuestionCard question={q} /> : null;
  }
  if (item.t === "plan") return <PlanCard item={item} />;
  const author = state.roster[item.authorId];
  const agent = state.agents[item.authorId];
  if (item.t === "chip") {
    return (
      <div className="chip-row mono">
        <span className="chip-dot" /> {author?.name ?? item.authorId} · {item.text}
      </div>
    );
  }
  return (
    <div className="msg-row">
      <Avatar user={author} agent={agent} />
      <div className="msg-main">
        <div className="msg-meta">
          <span className="msg-author">{author?.name ?? item.authorId}</span>
          {author?.kind === "agent" && <span className="badge badge-agent">AGENT</span>}
          <span className="msg-ts mono">{new Date(item.ts).toLocaleTimeString()}</span>
        </div>
        <div className="msg-text">{item.text}</div>
      </div>
    </div>
  );
}

function PendingBubble({ turn }: { turn: PendingTurn }) {
  const { state } = useStore();
  const author = state.roster[turn.agentId];
  return (
    <div className="msg-row msg-pending">
      <Avatar user={author} agent={state.agents[turn.agentId]} />
      <div className="msg-main">
        <div className="msg-meta">
          <span className="msg-author">{author?.name ?? turn.agentId}</span>
          <span className="badge badge-agent">AGENT</span>
          <span className="mono msg-streaming">streaming…</span>
        </div>
        <div className="msg-text">
          {turn.text}
          <span className="caret" />
        </div>
      </div>
    </div>
  );
}

function Roster({ channel }: { channel: Channel }) {
  const { state } = useStore();
  const notice = useNotice();
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [driver, setDriver] = useState<"mock" | "anthropic">("mock");
  const [allowlist, setAllowlist] = useState("");
  const [busy, setBusy] = useState(false);

  const addAgent = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api(state.token, "POST", "/api/agents", {
        name: name.trim(),
        persona: persona.trim(),
        driver,
        channelId: channel.id,
        ...(allowlist.trim()
          ? { networkAllowlist: allowlist.split(",").map((h) => h.trim()).filter(Boolean) }
          : {}),
      });
      setName("");
      setPersona("");
      setAllowlist("");
    } catch (err) {
      notice(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="roster">
      <div className="panel-title mono">MEMBERS · {channel.memberIds.length}</div>
      <ul className="roster-list">
        {channel.memberIds.map((id) => {
          const u = state.roster[id];
          const agent = state.agents[id];
          if (!u) return null;
          const responding =
            u.kind === "agent" &&
            Object.values(state.pendingTurns).some((t) => t.channelId === channel.id && t.agentId === id);
          return (
            <li key={id} className="roster-row">
              <Avatar user={u} agent={agent} />
              <span className="roster-name">{u.name}</span>
              {u.kind === "agent" &&
                (responding ? (
                  <span className="presence-chip mono" data-testid="presence-chip">responding…</span>
                ) : (
                  <span className="presence-dot" title="idle" data-testid="presence-idle" />
                ))}
              <span className={`badge ${u.kind === "agent" ? "badge-agent" : "badge-human"}`}>
                {u.kind === "agent" ? "AGENT" : "HUMAN"}
              </span>
            </li>
          );
        })}
      </ul>
      <form className="add-agent" onSubmit={addAgent}>
        <div className="panel-title mono">ADD AGENT</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Agent name" />
        <input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Persona" aria-label="Agent persona" />
        <input
          value={allowlist}
          onChange={(e) => setAllowlist(e.target.value)}
          placeholder="Network allowlist (hosts, comma-sep)"
          aria-label="Network allowlist"
        />
        <select value={driver} onChange={(e) => setDriver(e.target.value === "anthropic" ? "anthropic" : "mock")} aria-label="Agent driver">
          <option value="mock">driver: mock</option>
          <option value="anthropic">driver: anthropic</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Add agent</button>
      </form>
      <RoutinesSection channel={channel} />
    </aside>
  );
}

function RoutinesSection({ channel }: { channel: Channel }) {
  const { state, dispatch } = useStore();
  const notice = useNotice();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [minutes, setMinutes] = useState("60");
  const routines = Object.values(state.routines).filter((r) => r.channelId === channel.id);
  const channelAgents = channel.memberIds.map((id) => state.agents[id]).filter((a): a is AgentRecord => !!a);

  const runNow = async (routine: RoutineRecord) => {
    try {
      await api(state.token, "POST", `/api/routines/${routine.id}/run`);
    } catch (err) {
      notice(err);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const agent = agentId || channelAgents[0]?.id;
    if (!name.trim() || !prompt.trim() || !agent) return;
    try {
      const { routine } = await api<{ routine: RoutineRecord }>(state.token, "POST", "/api/routines", {
        name: name.trim(),
        agentId: agent,
        channelId: channel.id,
        prompt: prompt.trim(),
        schedule: minutes === "manual" ? { kind: "manual" } : { kind: "interval", minutes: Number(minutes) },
      });
      dispatch({ a: "routine-created", routine });
      setName("");
      setPrompt("");
    } catch (err) {
      notice(err);
    }
  };

  return (
    <div className="routines" data-testid="routines-section">
      <div className="panel-title mono panel-title-gap">ROUTINES · {routines.length}</div>
      {routines.length === 0 && <div className="panel-empty">No routines in this channel.</div>}
      {routines.map((r) => (
        <div key={r.id} className="routine-card">
          <div className="routine-name">{r.name}</div>
          <div className="routine-meta mono">
            @{state.agents[r.agentId]?.name ?? r.agentId} ·{" "}
            {r.schedule.kind === "interval" ? `every ${r.schedule.minutes}m` : "manual"}
          </div>
          <div className="routine-meta mono">
            last run: {r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : "never"}
          </div>
          <button className="btn btn-ghost routine-run" onClick={() => runNow(r)}>Run now</button>
        </div>
      ))}
      <form className="routine-form" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Routine name" aria-label="Routine name" />
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt for the agent" aria-label="Routine prompt" />
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Routine agent">
          {channelAgents.map((a) => (
            <option key={a.id} value={a.id}>@{a.name}</option>
          ))}
        </select>
        <select value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Routine schedule">
          <option value="manual">manual</option>
          <option value="60">every 60m</option>
          <option value="1440">daily</option>
          <option value="10080">weekly</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || !prompt.trim() || channelAgents.length === 0}>
          Create routine
        </button>
      </form>
    </div>
  );
}

function ChatView({ channel, onPromote }: { channel: Channel; onPromote?: () => void }) {
  const { state } = useStore();
  const feed = state.feeds[channel.id] ?? [];
  const pending = Object.values(state.pendingTurns).filter((t) => t.channelId === channel.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed.length, pending.map((p) => p.text).join("")]);

  return (
    <section className="chat">
      <header className="chat-head">
        <h2>{channel.space === "dm" ? channel.name : <><span className="channel-hash">#</span>{channel.name}</>}</h2>
        <span className="mono chat-space">{channel.space === "dm" ? "direct message" : `space · ${channel.space}`}</span>
        {onPromote && (
          <button className="btn btn-ghost chat-promote" title="Turn this conversation into a background goal" onClick={onPromote}>
            Promote to goal →
          </button>
        )}
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {feed.length === 0 && pending.length === 0 && (
          <div className="chat-empty">No messages yet. Say hello — or add an agent and @mention it.</div>
        )}
        {feed.map((item) => (
          <FeedRow key={item.eventId} item={item} />
        ))}
        {pending.map((turn) => (
          <PendingBubble key={turn.turnId} turn={turn} />
        ))}
      </div>
      <Composer channel={channel} />
    </section>
  );
}

// ---------- Shell ----------

function Shell() {
  const { state, dispatch } = useStore();
  const [view, setView] = useState<View>("channels");
  const [promoteChannelId, setPromoteChannelId] = useState<string | null>(null);
  const channel = state.channels.find((c) => c.id === state.currentChannelId) ?? null;

  return (
    <div className="shell">
      <Sidebar view={view} setView={setView} />
      <div className="shell-main">
        {state.notice && (
          <div className="notice" role="alert">
            {state.notice}
            <button className="btn btn-ghost" onClick={() => dispatch({ a: "notice", text: null })}>✕</button>
          </div>
        )}
        <div className="shell-body">
          {view === "inbox" && <InboxView goTo={setView} />}
          {view === "board" && <BoardView goTo={setView} />}
          {view === "goals" && <GoalsView initialChannelId={promoteChannelId} />}
          {view === "pipelines" && <PipelinesView />}
          {view === "costs" && <CostsView />}
          {view === "memory" && <MemoryView />}
          {view === "files" && <FilesView />}
          {view === "computer" && <ComputerView />}
          {view === "admin" && <AdminView />}
          {view === "channels" &&
            (channel ? (
              <>
                <ChatView
                  channel={channel}
                  onPromote={() => {
                    setPromoteChannelId(channel.id);
                    setView("goals");
                  }}
                />
                <Roster channel={channel} />
              </>
            ) : (
              <div className="empty-state shell-welcome">
                <div className="empty-title serif">Welcome to Atrium</div>
                <p>Create or pick a channel to get started.</p>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state } = useStore();
  return state.token ? <Shell /> : <Login />;
}
