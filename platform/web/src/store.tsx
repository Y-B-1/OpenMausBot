// Atrium web store: one hand-rolled useReducer + context store that folds
// REST state and live WS events. Mirrors the server's event-kind switch.
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import { EventKind } from "../../shared/contracts.ts";
import type {
  AgentRecord,
  Approval,
  AtriumEvent,
  Channel,
  ConnectorRecord,
  DataRow,
  GoalRecord,
  InboxItem,
  MemoryEntry,
  PipelineRun,
  QuestionRecord,
  RoutineRecord,
  TeamRecord,
  TemplateRecord,
  TurnCost,
  User,
} from "../../shared/contracts.ts";

// ---------- Feed model ----------

export type FeedItem =
  | { t: "msg"; eventId: string; authorId: string; ts: number; text: string }
  | { t: "chip"; eventId: string; authorId: string; ts: number; text: string }
  | { t: "approval"; eventId: string; approvalId: string; ts: number }
  | { t: "question"; eventId: string; questionId: string; ts: number }
  | { t: "plan"; eventId: string; authorId: string; ts: number; plan: string[]; sql_like: string; resultPreview: DataRow[] };

export type PendingTurn = { turnId: string; agentId: string; text: string; channelId: string };

export type SandboxEvent = {
  eventId: string;
  agentId: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  ts: number;
};

export type WsStatus = "disconnected" | "connecting" | "connected";

export type ProviderStatus = {
  id: string;
  label: string;
  requires: string[];
  present: string[];
  ready: boolean;
  enables: string;
};

export type State = {
  token: string | null;
  me: User | null;
  channels: Channel[];
  roster: Record<string, User>;
  agents: Record<string, AgentRecord>;
  memory: Record<string, MemoryEntry>;
  approvals: Record<string, Approval>;
  routines: Record<string, RoutineRecord>;
  inbox: Record<string, InboxItem>;
  questions: Record<string, QuestionRecord>;
  goals: Record<string, GoalRecord>;
  templates: Record<string, TemplateRecord>;
  pipelines: Record<string, PipelineRun>;
  costs: TurnCost[];
  teams: Record<string, TeamRecord>;
  connectors: Record<string, ConnectorRecord>;
  providers: ProviderStatus[];
  feeds: Record<string, FeedItem[]>;
  pendingTurns: Record<string, PendingTurn>;
  sandboxEvents: SandboxEvent[];
  currentChannelId: string | null;
  wsStatus: WsStatus;
  notice: string | null;
};

export const initialState: State = {
  token: null,
  me: null,
  channels: [],
  roster: {},
  agents: {},
  memory: {},
  approvals: {},
  routines: {},
  inbox: {},
  questions: {},
  goals: {},
  templates: {},
  pipelines: {},
  costs: [],
  teams: {},
  connectors: {},
  providers: [],
  feeds: {},
  pendingTurns: {},
  sandboxEvents: [],
  currentChannelId: null,
  wsStatus: "disconnected",
  notice: null,
};

export type StateSnapshot = {
  channels: Channel[];
  roster: User[];
  agents: AgentRecord[];
  memory: MemoryEntry[];
  approvals: Approval[];
  routines: RoutineRecord[];
  inbox?: InboxItem[];
  questions?: QuestionRecord[];
  goals?: GoalRecord[];
  templates?: TemplateRecord[];
  pipelines?: PipelineRun[];
  costs?: TurnCost[];
  teams?: TeamRecord[];
  connectors?: ConnectorRecord[];
  providers?: ProviderStatus[];
  me?: User | null;
  transcripts: Record<
    string,
    Array<{
      eventId: string;
      authorId: string;
      ts: number;
      type: "message" | "chip" | "plan";
      text: string;
      plan?: { plan: string[]; sql_like: string; resultPreview: DataRow[] };
    }>
  >;
};

export type Action =
  | { a: "login"; token: string; me: User }
  | { a: "snapshot"; snap: StateSnapshot }
  | { a: "select-channel"; channelId: string }
  | { a: "channel-created"; channel: Channel }
  | { a: "ws-status"; status: WsStatus }
  | { a: "ws-event"; event: AtriumEvent }
  // Local fold: kind-41/42 are emitted server-side without a channelId, so
  // they never fan out over WS — apply the review outcome after the POST.
  | { a: "memory-reviewed"; entryId: string; accepted: boolean }
  | { a: "routine-created"; routine: RoutineRecord }
  | { a: "notice"; text: string | null };

function pushFeed(feeds: Record<string, FeedItem[]>, channelId: string, item: FeedItem): Record<string, FeedItem[]> {
  const list = feeds[channelId] ?? [];
  if (list.some((i) => i.eventId === item.eventId)) return feeds;
  return { ...feeds, [channelId]: [...list, item] };
}

function foldEvent(state: State, ev: AtriumEvent): State {
  const body = ev.body;
  const ch = ev.channelId ?? "";
  switch (body.kind) {
    case EventKind.Message:
      return { ...state, feeds: pushFeed(state.feeds, ch, { t: "msg", eventId: ev.id, authorId: ev.authorId, ts: ev.ts, text: body.text }) };
    case EventKind.ChannelCreated: {
      if (state.channels.some((c) => c.id === body.channel.id)) return state;
      return { ...state, channels: [...state.channels, body.channel] };
    }
    case EventKind.MemberAdded: {
      const roster = body.user ? { ...state.roster, [body.user.id]: body.user } : state.roster;
      const agents = body.agent ? { ...state.agents, [body.agent.id]: body.agent } : state.agents;
      const channels = ch
        ? state.channels.map((c) =>
            c.id === ch && !c.memberIds.includes(body.userId) ? { ...c, memberIds: [...c.memberIds, body.userId] } : c,
          )
        : state.channels;
      return { ...state, roster, agents, channels };
    }
    case EventKind.AgentTurnStarted:
      return {
        ...state,
        pendingTurns: { ...state.pendingTurns, [body.turnId]: { turnId: body.turnId, agentId: ev.authorId, text: "", channelId: ch } },
        feeds: pushFeed(state.feeds, ch, { t: "chip", eventId: ev.id, authorId: ev.authorId, ts: ev.ts, text: "turn started" }),
      };
    case EventKind.AgentStreamDelta: {
      const turn = state.pendingTurns[body.turnId];
      if (!turn) return state;
      return { ...state, pendingTurns: { ...state.pendingTurns, [body.turnId]: { ...turn, text: turn.text + body.delta } } };
    }
    case EventKind.AgentTurnCompleted: {
      const pendingTurns = { ...state.pendingTurns };
      delete pendingTurns[body.turnId];
      return {
        ...state,
        pendingTurns,
        feeds: pushFeed(state.feeds, ch, { t: "chip", eventId: ev.id, authorId: ev.authorId, ts: ev.ts, text: "turn completed" }),
      };
    }
    case EventKind.ApprovalRequested:
      return {
        ...state,
        approvals: { ...state.approvals, [body.approval.id]: body.approval },
        feeds: pushFeed(state.feeds, ch, { t: "approval", eventId: ev.id, approvalId: body.approval.id, ts: ev.ts }),
      };
    case EventKind.ApprovalResolved: {
      const existing = state.approvals[body.approvalId];
      if (!existing) return state;
      return { ...state, approvals: { ...state.approvals, [body.approvalId]: { ...existing, status: body.status } } };
    }
    case EventKind.MemoryProposed:
      return { ...state, memory: { ...state.memory, [body.entry.id]: body.entry } };
    case EventKind.MemoryAccepted: {
      const entry = state.memory[body.entryId];
      if (!entry) return state;
      return { ...state, memory: { ...state.memory, [body.entryId]: { ...entry, trustTier: "human_confirmed" } } };
    }
    case EventKind.MemoryRejected: {
      const entry = state.memory[body.entryId];
      if (!entry) return state;
      return { ...state, memory: { ...state.memory, [body.entryId]: { ...entry, status: "retired" } } };
    }
    case EventKind.SandboxExec:
      if (state.sandboxEvents.some((s) => s.eventId === ev.id)) return state;
      return {
        ...state,
        sandboxEvents: [
          ...state.sandboxEvents,
          { eventId: ev.id, agentId: body.agentId, argv: body.argv, exitCode: body.exitCode, stdout: body.stdout, ts: ev.ts },
        ],
      };
    case EventKind.PlanExecuted:
      return {
        ...state,
        feeds: pushFeed(state.feeds, ch, {
          t: "plan",
          eventId: ev.id,
          authorId: ev.authorId,
          ts: ev.ts,
          plan: body.plan,
          sql_like: body.sql_like,
          resultPreview: body.resultPreview,
        }),
      };
    case EventKind.InboxPosted:
      return { ...state, inbox: { ...state.inbox, [body.item.id]: body.item } };
    case EventKind.InboxReplied: {
      const item = state.inbox[body.itemId];
      if (!item) return state;
      return { ...state, inbox: { ...state.inbox, [body.itemId]: { ...item, status: "replied", reply: body.reply } } };
    }
    case EventKind.QuestionAsked:
      return {
        ...state,
        questions: { ...state.questions, [body.question.id]: body.question },
        feeds: pushFeed(state.feeds, ch, { t: "question", eventId: ev.id, questionId: body.question.id, ts: ev.ts }),
      };
    case EventKind.QuestionAnswered: {
      const q = state.questions[body.questionId];
      if (!q) return state;
      return { ...state, questions: { ...state.questions, [body.questionId]: { ...q, status: "answered", answer: body.answer } } };
    }
    case EventKind.GoalCreated:
      return { ...state, goals: { ...state.goals, [body.goal.id]: body.goal } };
    case EventKind.GoalSessionCompleted: {
      const g = state.goals[body.goalId];
      if (!g) return state;
      return { ...state, goals: { ...state.goals, [body.goalId]: { ...g, sessions: body.session, spentUsd: body.spentUsd } } };
    }
    case EventKind.GoalCriterionChecked: {
      const g = state.goals[body.goalId];
      if (!g) return state;
      const criteria = g.criteria.map((c) => (c.id === body.criterionId ? { ...c, done: true } : c));
      return { ...state, goals: { ...state.goals, [body.goalId]: { ...g, criteria } } };
    }
    case EventKind.GoalCompleted: {
      const g = state.goals[body.goalId];
      if (!g) return state;
      return { ...state, goals: { ...state.goals, [body.goalId]: { ...g, status: "done" } } };
    }
    case EventKind.GoalHalted: {
      const g = state.goals[body.goalId];
      if (!g) return state;
      return { ...state, goals: { ...state.goals, [body.goalId]: { ...g, status: "halted", haltReason: body.reason } } };
    }
    case EventKind.TemplateCreated:
      return { ...state, templates: { ...state.templates, [body.template.id]: body.template } };
    case EventKind.PipelineStarted:
      return { ...state, pipelines: { ...state.pipelines, [body.run.id]: body.run } };
    case EventKind.PipelineStepStarted: {
      const run = state.pipelines[body.runId];
      if (!run) return state;
      const stepStates = run.stepStates.map((s, i) => (i === body.stepIndex ? ("running" as const) : s));
      return { ...state, pipelines: { ...state.pipelines, [body.runId]: { ...run, stepIndex: body.stepIndex, stepStates } } };
    }
    case EventKind.PipelineStepCompleted: {
      const run = state.pipelines[body.runId];
      if (!run) return state;
      const stepStates = run.stepStates.map((s, i) =>
        i === body.stepIndex ? (body.gated ? ("awaiting_approval" as const) : ("done" as const)) : s,
      );
      return { ...state, pipelines: { ...state.pipelines, [body.runId]: { ...run, stepStates } } };
    }
    case EventKind.PipelineCompleted: {
      const run = state.pipelines[body.runId];
      if (!run) return state;
      return { ...state, pipelines: { ...state.pipelines, [body.runId]: { ...run, status: "done" } } };
    }
    case EventKind.TurnCostRecorded:
      if (state.costs.some((c) => c.turnId === body.cost.turnId)) return state;
      return { ...state, costs: [...state.costs, body.cost] };
    case EventKind.TeamCreated:
      return { ...state, teams: { ...state.teams, [body.team.id]: body.team } };
    case EventKind.TeamMemberAdded: {
      const team = state.teams[body.teamId];
      if (!team || team.memberIds.includes(body.userId)) return state;
      return { ...state, teams: { ...state.teams, [body.teamId]: { ...team, memberIds: [...team.memberIds, body.userId] } } };
    }
    case EventKind.RoleChanged: {
      const user = state.roster[body.userId];
      const roster = user ? { ...state.roster, [body.userId]: { ...user, role: body.role } } : state.roster;
      const me = state.me?.id === body.userId ? { ...state.me, role: body.role } : state.me;
      return { ...state, roster, me };
    }
    case EventKind.ConnectorCreated:
      return { ...state, connectors: { ...state.connectors, [body.connector.id]: body.connector } };
    case EventKind.ConnectorUpdated: {
      const c = state.connectors[body.connectorId];
      if (!c) return state;
      return {
        ...state,
        connectors: {
          ...state.connectors,
          [body.connectorId]: { ...c, ...(body.status ? { status: body.status } : {}), ...(body.tools ? { tools: body.tools } : {}) },
        },
      };
    }
    case EventKind.ConnectorSynced: {
      const c = state.connectors[body.connectorId];
      const memory = { ...state.memory };
      for (const entry of body.entries) memory[entry.id] = entry;
      const connectors = c
        ? { ...state.connectors, [body.connectorId]: { ...c, syncedCount: c.syncedCount + body.entries.length, lastSyncAt: body.ranAt } }
        : state.connectors;
      return { ...state, memory, connectors };
    }
    case EventKind.RoutineCreated:
      return { ...state, routines: { ...state.routines, [body.routine.id]: body.routine } };
    case EventKind.RoutineRunCompleted: {
      const routine = state.routines[body.routineId];
      if (!routine) return state;
      return { ...state, routines: { ...state.routines, [body.routineId]: { ...routine, lastRunAt: body.ranAt } } };
    }
    default:
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.a) {
    case "login":
      return { ...state, token: action.token, me: action.me };
    case "snapshot": {
      const roster: Record<string, User> = {};
      for (const u of action.snap.roster) roster[u.id] = u;
      const agents: Record<string, AgentRecord> = {};
      for (const a of action.snap.agents) agents[a.id] = a;
      const memory: Record<string, MemoryEntry> = {};
      for (const m of action.snap.memory) memory[m.id] = m;
      const approvals: Record<string, Approval> = {};
      for (const ap of action.snap.approvals) approvals[ap.id] = ap;
      const routines: Record<string, RoutineRecord> = {};
      for (const r of action.snap.routines ?? []) routines[r.id] = r;
      const inbox: Record<string, InboxItem> = {};
      for (const i of action.snap.inbox ?? []) inbox[i.id] = i;
      const questions: Record<string, QuestionRecord> = {};
      for (const q of action.snap.questions ?? []) questions[q.id] = q;
      const goals: Record<string, GoalRecord> = {};
      for (const g of action.snap.goals ?? []) goals[g.id] = g;
      const templates: Record<string, TemplateRecord> = {};
      for (const t of action.snap.templates ?? []) templates[t.id] = t;
      const pipelines: Record<string, PipelineRun> = {};
      for (const p of action.snap.pipelines ?? []) pipelines[p.id] = p;
      const teams: Record<string, TeamRecord> = {};
      for (const t of action.snap.teams ?? []) teams[t.id] = t;
      const connectors: Record<string, ConnectorRecord> = {};
      for (const c of action.snap.connectors ?? []) connectors[c.id] = c;
      const feeds: Record<string, FeedItem[]> = {};
      for (const [chId, items] of Object.entries(action.snap.transcripts)) {
        feeds[chId] = items.map((i): FeedItem => {
          if (i.type === "plan" && i.plan) {
            return {
              t: "plan",
              eventId: i.eventId,
              authorId: i.authorId,
              ts: i.ts,
              plan: i.plan.plan,
              sql_like: i.plan.sql_like,
              resultPreview: i.plan.resultPreview,
            };
          }
          return i.type === "message"
            ? { t: "msg", eventId: i.eventId, authorId: i.authorId, ts: i.ts, text: i.text }
            : { t: "chip", eventId: i.eventId, authorId: i.authorId, ts: i.ts, text: i.text };
        });
      }
      // Surface pre-existing approval cards at the end of their channel feeds.
      for (const ap of action.snap.approvals) {
        const list = feeds[ap.channelId] ?? [];
        list.push({ t: "approval", eventId: `approval-${ap.id}`, approvalId: ap.id, ts: Date.now() });
        feeds[ap.channelId] = list;
      }
      return {
        ...state,
        channels: action.snap.channels,
        roster,
        agents,
        memory,
        approvals,
        routines,
        inbox,
        questions,
        goals,
        templates,
        pipelines,
        teams,
        connectors,
        providers: action.snap.providers ?? [],
        me: action.snap.me ?? state.me,
        costs: action.snap.costs ?? [],
        feeds,
      };
    }
    case "select-channel":
      return { ...state, currentChannelId: action.channelId };
    case "channel-created":
      return foldEvent({ ...state, currentChannelId: action.channel.id }, {
        id: `local-${action.channel.id}`,
        org: "acme",
        kind: EventKind.ChannelCreated,
        authorId: state.me?.id ?? "",
        ts: Date.now(),
        body: { kind: EventKind.ChannelCreated, channel: action.channel },
      });
    case "ws-status":
      return { ...state, wsStatus: action.status };
    case "ws-event":
      return foldEvent(state, action.event);
    case "memory-reviewed": {
      const entry = state.memory[action.entryId];
      if (!entry) return state;
      const updated = action.accepted
        ? { ...entry, trustTier: "human_confirmed" as const }
        : { ...entry, status: "retired" as const };
      return { ...state, memory: { ...state.memory, [action.entryId]: updated } };
    }
    case "routine-created":
      return { ...state, routines: { ...state.routines, [action.routine.id]: action.routine } };
    case "notice":
      return { ...state, notice: action.text };
  }
}

// ---------- API helpers ----------

export async function api<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- Context + WS lifecycle ----------

const StoreCtx = createContext<{ state: State; dispatch: Dispatch<Action> }>({
  state: initialState,
  dispatch: () => {},
});

export function useStore(): { state: State; dispatch: Dispatch<Action> } {
  return useContext(StoreCtx);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const currentChannelRef = useRef<string | null>(null);
  currentChannelRef.current = state.currentChannelId;

  // WS connection tied to token; simple retry with backoff on drop.
  useEffect(() => {
    if (!state.token) return;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      dispatch({ a: "ws-status", status: "connecting" });
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`);
      wsRef.current = ws;
      subscribedRef.current = new Set();
      ws.onopen = () => {
        attempt = 0;
        dispatch({ a: "ws-status", status: "connected" });
        const ch = currentChannelRef.current;
        if (ch) {
          ws.send(JSON.stringify({ subscribe: ch }));
          subscribedRef.current.add(ch);
        }
      };
      ws.onmessage = (msg) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(String(msg.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (data["event"]) {
          dispatch({ a: "ws-event", event: data["event"] as AtriumEvent });
        } else if (typeof data["error"] === "string") {
          dispatch({ a: "notice", text: `subscription refused: ${data["error"]}` });
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (closed) return;
        dispatch({ a: "ws-status", status: "disconnected" });
        attempt += 1;
        timer = setTimeout(connect, Math.min(500 * 2 ** attempt, 8000));
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [state.token]);

  // Subscribe on channel select (membership check happens server-side).
  useEffect(() => {
    const ch = state.currentChannelId;
    const ws = wsRef.current;
    if (!ch || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (subscribedRef.current.has(ch)) return;
    ws.send(JSON.stringify({ subscribe: ch }));
    subscribedRef.current.add(ch);
  }, [state.currentChannelId, state.wsStatus]);

  return <StoreCtx.Provider value={{ state, dispatch }}>{children}</StoreCtx.Provider>;
}
