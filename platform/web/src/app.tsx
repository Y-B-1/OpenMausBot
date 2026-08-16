// Atrium web UI (T10–T13): app shell, chat, approvals, memory review, computer panel.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentRecord, Approval, Channel, MemoryEntry, User } from "../../shared/contracts.ts";
import { api, useStore, type FeedItem, type PendingTurn, type StateSnapshot } from "./store.tsx";

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
        <h1>Atrium</h1>
        <p className="login-sub">Channels where humans and agents work side by side.</p>
        <label className="field-label" htmlFor="login-name">Your name</label>
        <input
          id="login-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Yosri"
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Signing in…" : "Enter the atrium"}
        </button>
        {err && <p className="error-text">{err}</p>}
      </form>
    </div>
  );
}

// ---------- Left rail ----------

function ChannelRail() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");

  const createChannel = async (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      const { channel } = await api<{ channel: Channel }>(state.token, "POST", "/api/channels", { name, space: "general" });
      dispatch({ a: "channel-created", channel });
      setDraft("");
    } catch (err) {
      dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
    }
  };

  return (
    <nav className="rail">
      <div className="rail-org">
        <span className="rail-org-mark">A</span>
        <div>
          <div className="rail-org-name">Atrium</div>
          <div className="rail-org-sub mono">org · acme</div>
        </div>
      </div>
      <div className="rail-section-title mono">CHANNELS</div>
      <ul className="channel-list">
        {state.channels.map((c) => (
          <li key={c.id}>
            <button
              className={`channel-item ${state.currentChannelId === c.id ? "active" : ""}`}
              onClick={() => dispatch({ a: "select-channel", channelId: c.id })}
            >
              <span className="channel-hash">#</span> {c.name}
            </button>
          </li>
        ))}
        {state.channels.length === 0 && <li className="rail-empty">No channels yet.</li>}
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

// ---------- Roster + add agent ----------

function Roster({ channel }: { channel: Channel }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [driver, setDriver] = useState<"mock" | "anthropic">("mock");
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
      });
      setName("");
      setPersona("");
    } catch (err) {
      dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
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
          return (
            <li key={id} className="roster-row">
              <Avatar user={u} agent={agent} />
              <span className="roster-name">{u.name}</span>
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
        <select value={driver} onChange={(e) => setDriver(e.target.value === "anthropic" ? "anthropic" : "mock")} aria-label="Agent driver">
          <option value="mock">driver: mock</option>
          <option value="anthropic">driver: anthropic</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Add agent</button>
      </form>
    </aside>
  );
}

// ---------- Approval card ----------

function ApprovalCard({ approval }: { approval: Approval }) {
  const { state, dispatch } = useStore();
  const agent = state.agents[approval.agentId];
  const respond = async (approve: boolean) => {
    try {
      await api(state.token, "POST", `/api/approvals/${approval.id}`, { approve });
    } catch (err) {
      dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
    }
  };
  return (
    <div className={`approval-card approval-${approval.status}`}>
      <div className="approval-head">
        <span className="mono approval-kind">APPROVAL · kind 30</span>
        <span className={`badge badge-status-${approval.status}`}>{approval.status.toUpperCase()}</span>
      </div>
      <div className="approval-body">
        <strong>{agent?.name ?? approval.agentId}</strong> wants to run <code className="mono">{approval.tool}</code>
      </div>
      <pre className="mono approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
      {approval.status === "pending" ? (
        <div className="approval-actions">
          <button className="btn btn-primary" onClick={() => respond(true)}>Approve</button>
          <button className="btn btn-danger" onClick={() => respond(false)}>Deny</button>
        </div>
      ) : (
        <div className="approval-outcome mono">resolved · {approval.status}</div>
      )}
    </div>
  );
}

// ---------- Composer with @mention autocomplete ----------

function Composer({ channel }: { channel: Channel }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const channelAgents = useMemo(
    () => channel.memberIds.map((id) => state.agents[id]).filter((a): a is AgentRecord => !!a),
    [channel.memberIds, state.agents],
  );

  // Mention detection: token after the last '@' at/behind the caret-ish end.
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
      dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
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
      <button type="submit" className="btn btn-primary" disabled={!text.trim()}>Send</button>
    </form>
  );
}

// ---------- Chat feed ----------

function FeedRow({ item }: { item: FeedItem }) {
  const { state } = useStore();
  if (item.t === "approval") {
    const ap = state.approvals[item.approvalId];
    return ap ? <ApprovalCard approval={ap} /> : null;
  }
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

function ChatView({ channel }: { channel: Channel }) {
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
        <h2><span className="channel-hash">#</span>{channel.name}</h2>
        <span className="mono chat-space">space · {channel.space}</span>
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

// ---------- Memory panel ----------

const TIER_LABEL: Record<string, string> = {
  quarantined: "quarantined",
  agent_proposed: "agent proposed",
  human_confirmed: "human confirmed",
  org_ratified: "org ratified",
};

function MemoryCard({ entry, reviewable }: { entry: MemoryEntry; reviewable: boolean }) {
  const { state, dispatch } = useStore();
  const author = state.roster[entry.provenance.author];
  const review = async (accept: boolean) => {
    try {
      await api(state.token, "POST", `/api/memory/${entry.id}/review`, { accept });
      dispatch({ a: "memory-reviewed", entryId: entry.id, accepted: accept });
    } catch (err) {
      dispatch({ a: "notice", text: String(err instanceof Error ? err.message : err) });
    }
  };
  return (
    <div className="mem-card">
      <div className="mem-content">{entry.content}</div>
      <div className="mem-meta mono">
        <span className="tag">{entry.scope}</span>
        <span className="tag">{entry.kind}</span>
        <span className={`tag tag-tier-${entry.trustTier}`}>{TIER_LABEL[entry.trustTier] ?? entry.trustTier}</span>
      </div>
      <div className="mem-prov mono">by {author?.name ?? entry.provenance.author} · session {entry.provenance.sessionRef.slice(0, 8)}</div>
      {reviewable && (
        <div className="mem-actions">
          <button className="btn btn-primary" onClick={() => review(true)}>Accept</button>
          <button className="btn btn-danger" onClick={() => review(false)}>Reject</button>
        </div>
      )}
    </div>
  );
}

function MemoryPanel() {
  const { state } = useStore();
  const entries = Object.values(state.memory).filter((m) => m.status === "active");
  const queue = entries.filter((m) => m.trustTier === "quarantined" || m.trustTier === "agent_proposed");
  const accepted = entries.filter((m) => m.trustTier === "human_confirmed" || m.trustTier === "org_ratified");
  const byScope = { org: accepted.filter((m) => m.scope === "org"), space: accepted.filter((m) => m.scope === "space"), personal: accepted.filter((m) => m.scope === "personal") };

  return (
    <aside className="side-panel" data-testid="memory-panel">
      <div className="panel-title mono">MEMORY · REVIEW QUEUE ({queue.length})</div>
      {queue.length === 0 && <div className="panel-empty">Nothing awaiting review.</div>}
      {queue.map((m) => (
        <MemoryCard key={m.id} entry={m} reviewable />
      ))}
      <div className="panel-title mono panel-title-gap">ACCEPTED MEMORY</div>
      {(["org", "space", "personal"] as const).map((scope) => (
        <div key={scope} className="mem-group">
          <div className="mem-group-title mono">{scope} ({byScope[scope].length})</div>
          {byScope[scope].map((m) => (
            <MemoryCard key={m.id} entry={m} reviewable={false} />
          ))}
        </div>
      ))}
    </aside>
  );
}

// ---------- Computer panel ----------

function ComputerPanel() {
  const { state } = useStore();
  const byAgent = new Map<string, typeof state.sandboxEvents>();
  for (const ev of state.sandboxEvents) {
    const list = byAgent.get(ev.agentId) ?? [];
    list.push(ev);
    byAgent.set(ev.agentId, list);
  }
  return (
    <aside className="side-panel" data-testid="computer-panel">
      <div className="panel-title mono">COMPUTER · SANDBOX AUDIT</div>
      {byAgent.size === 0 && <div className="panel-empty">No sandbox executions yet.</div>}
      {[...byAgent.entries()].map(([agentId, evs]) => (
        <div key={agentId} className="mem-group">
          <div className="mem-group-title mono">
            {state.roster[agentId]?.name ?? agentId} · {evs.length} exec{evs.length === 1 ? "" : "s"}
          </div>
          {evs.map((ev) => (
            <div key={ev.eventId} className="exec-card">
              <div className="mono exec-argv">$ {ev.argv.join(" ")}</div>
              <div className="mono exec-exit">
                exit <span className={ev.exitCode === 0 ? "exit-ok" : "exit-bad"}>{ev.exitCode}</span> · kind 50
              </div>
              {ev.stdout && <pre className="mono exec-stdout">{ev.stdout.slice(0, 400)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}

// ---------- Shell ----------

function Shell() {
  const { state, dispatch } = useStore();
  const [panel, setPanel] = useState<"none" | "memory" | "computer">("none");
  const channel = state.channels.find((c) => c.id === state.currentChannelId) ?? null;
  const queueCount = Object.values(state.memory).filter(
    (m) => m.status === "active" && (m.trustTier === "quarantined" || m.trustTier === "agent_proposed"),
  ).length;

  return (
    <div className="shell">
      <ChannelRail />
      <div className="shell-main">
        <header className="topbar">
          <span className="topbar-title">{channel ? `#${channel.name}` : "Atrium"}</span>
          <div className="topbar-actions">
            <button
              className={`btn btn-ghost ${panel === "memory" ? "toggled" : ""}`}
              onClick={() => setPanel(panel === "memory" ? "none" : "memory")}
            >
              Memory{queueCount > 0 ? ` (${queueCount})` : ""}
            </button>
            <button
              className={`btn btn-ghost ${panel === "computer" ? "toggled" : ""}`}
              onClick={() => setPanel(panel === "computer" ? "none" : "computer")}
            >
              Computer
            </button>
            <span className="topbar-me">
              <Avatar user={state.me ?? undefined} /> {state.me?.name}
            </span>
          </div>
        </header>
        {state.notice && (
          <div className="notice" role="alert">
            {state.notice}
            <button className="btn btn-ghost" onClick={() => dispatch({ a: "notice", text: null })}>✕</button>
          </div>
        )}
        <div className="shell-body">
          {channel ? (
            <>
              <ChatView channel={channel} />
              <Roster channel={channel} />
            </>
          ) : (
            <div className="chat-empty shell-welcome">Create or pick a channel to get started.</div>
          )}
          {panel === "memory" && <MemoryPanel />}
          {panel === "computer" && <ComputerPanel />}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state } = useStore();
  return state.token ? <Shell /> : <Login />;
}
