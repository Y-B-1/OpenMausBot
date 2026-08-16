// Atrium relay (T3): node:http + ws, auth-lite, fail-closed org resolution,
// event pipeline: authenticate → membership check → append → fan-out →
// projections fold → side-effect hooks.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AgentRecord,
  AtriumEvent,
  Channel,
  ConnectorRecord,
  ConnectorTool,
  EventBody,
  GoalGuardrails,
  GoalRecord,
  ModelPolicy,
  PipelineRun,
  RoutineRecord,
  RoutineSchedule,
  TeamRecord,
  TemplateRecord,
  TemplateStep,
  User,
} from "../shared/contracts.ts";
import { EventKind } from "../shared/contracts.ts";
import { dataDir, EventStore, Projections } from "./store.ts";
import { exportYaml } from "./yaml.ts";
import { PROVIDER_CATALOG, defaultTools, providerInfo, syncItems } from "./connectors.ts";
import { providerStatuses } from "./providers.ts";

/** Tenancy seam (D4): single org, fail-closed. */
export function resolveOrg(hostHeader: string | undefined): string {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (host === "localhost" || host === "127.0.0.1") return "acme";
  throw new Error(`unknown tenant host: ${hostHeader ?? "<none>"}`);
}

/** Side-effect hook registry — Wave 2 plugs the agent dispatcher in here. */
export type EventHook = (event: AtriumEvent) => void;
const eventHooks: EventHook[] = [];
/** Register a hook; returns an unsubscribe function (additive Wave 2 change). */
export function onEvent(hook: EventHook): () => void {
  eventHooks.push(hook);
  return () => {
    const i = eventHooks.indexOf(hook);
    if (i >= 0) eventHooks.splice(i, 1);
  };
}
// No-op registration point (kept so the pipeline stage is exercised from day one).
onEvent(() => {});

type Session = { token: string; userId: string };

type Sub = { ws: WebSocket; userId: string; channels: Set<string> };

export type Relay = {
  server: http.Server;
  listen: (port?: number) => Promise<number>;
  close: () => Promise<void>;
  store: EventStore;
  projections: Projections;
  /** Inject an event through the full pipeline (append → fan-out → fold → hooks). Wave 2 seam. */
  emitEvent: (authorId: string, body: EventBody, channelId?: string, opts?: { ephemeral?: boolean }) => AtriumEvent;
  /** Wave 5 (T17): run all due interval routines now. Called every 30s by the internal timer; exported as a test seam. */
  tickRoutines: () => void;
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// W8 (one-command-start): serve the built web UI (web/dist) for non-API GETs.
const WEB_DIST = path.join(import.meta.dirname, "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  if (!fs.existsSync(WEB_DIST)) return false;
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  let file = path.normalize(path.join(WEB_DIST, rel));
  if (!file.startsWith(WEB_DIST)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
  return true;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export function createRelay(store: EventStore = new EventStore()): Relay {
  const projections = new Projections();
  projections.rebuild(store, "acme");

  const sessions = new Map<string, Session>(); // token -> session
  const subs = new Set<Sub>();

  // ---- W8 (auth-deployable): password hashes + session tokens persist under dataDir() ----
  const authFile = path.join(dataDir(), "auth.json");
  const sessionsFile = path.join(dataDir(), "sessions.json");
  type PasswordRec = { salt: string; hash: string };
  const passwords = new Map<string, PasswordRec>(); // user name -> scrypt record
  const readJsonFile = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  for (const [name, rec] of Object.entries(readJsonFile(authFile))) {
    const r = rec as Partial<PasswordRec>;
    if (typeof r.salt === "string" && typeof r.hash === "string") passwords.set(name, { salt: r.salt, hash: r.hash });
  }
  for (const [token, userId] of Object.entries(readJsonFile(sessionsFile))) {
    if (typeof userId === "string") sessions.set(token, { token, userId });
  }
  const savePasswords = (): void => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(Object.fromEntries(passwords)), "utf8");
  };
  const saveSessions = (): void => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries([...sessions.values()].map((s) => [s.token, s.userId]))), "utf8");
  };
  const hashPassword = (password: string, salt: string): string => crypto.scryptSync(password, salt, 32).toString("hex");

  const isMember = (channelId: string, userId: string): boolean => {
    const ch = projections.channels.get(channelId);
    return !!ch && ch.memberIds.includes(userId);
  };

  /** Pipeline tail: append (unless ephemeral) → fan-out → fold → hooks. */
  const emit = (event: AtriumEvent, opts: { ephemeral?: boolean } = {}): void => {
    if (!opts.ephemeral) store.append(event);
    if (event.channelId) {
      const payload = JSON.stringify({ event });
      for (const sub of subs) {
        if (sub.channels.has(event.channelId) && isMember(event.channelId, sub.userId)) {
          sub.ws.send(payload);
        }
      }
    }
    if (!opts.ephemeral) projections.fold(event);
    for (const hook of eventHooks) {
      try {
        hook(event);
      } catch {
        /* fire-and-forget */
      }
    }
  };

  const newEvent = (org: string, authorId: string, body: EventBody, channelId?: string): AtriumEvent => {
    const ev: AtriumEvent = {
      id: crypto.randomUUID(),
      org,
      kind: body.kind,
      authorId,
      ts: Date.now(),
      body,
    };
    if (channelId !== undefined) ev.channelId = channelId;
    return ev;
  };

  // ---- Wave 5 (T17): routines ----
  const ROUTINE_USER: User = { id: "routine", name: "Routine", kind: "human" };
  const ensureRoutineUser = (): void => {
    if (!projections.users.has(ROUTINE_USER.id)) {
      emit(newEvent("acme", ROUTINE_USER.id, { kind: EventKind.MemberAdded, userId: ROUTINE_USER.id, user: ROUTINE_USER }));
    }
  };

  /** Fire one routine: kind 71, a synthetic @mention message (the existing dispatch pipeline does the rest), kind 72. */
  const runRoutine = (routine: RoutineRecord): void => {
    const agent = projections.agents.get(routine.agentId);
    if (!agent) return;
    ensureRoutineUser();
    const ranAt = Date.now();
    emit(newEvent("acme", ROUTINE_USER.id, { kind: EventKind.RoutineRunStarted, routineId: routine.id }, routine.channelId));
    emit(newEvent("acme", ROUTINE_USER.id, { kind: EventKind.Message, text: `@${agent.name} ${routine.prompt}` }, routine.channelId));
    emit(newEvent("acme", ROUTINE_USER.id, { kind: EventKind.RoutineRunCompleted, routineId: routine.id, ranAt }, routine.channelId));
  };

  const tickRoutines = (): void => {
    const now = Date.now();
    for (const routine of projections.routines.values()) {
      if (routine.schedule.kind !== "interval") continue;
      const due = routine.lastRunAt === undefined || now - routine.lastRunAt >= routine.schedule.minutes * 60_000;
      if (due) runRoutine(routine);
    }
  };
  const routineTimer = setInterval(tickRoutines, 30_000);
  routineTimer.unref();

  const server = http.createServer((req, res) => {
    void (async () => {
      let org: string;
      try {
        org = resolveOrg(req.headers.host);
      } catch {
        return json(res, 421, { error: "unknown tenant" });
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // Built web UI (unauthenticated; login happens in-app).
      if (method === "GET" && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/ws")) {
        if (serveStatic(url.pathname, res)) return;
      }

      // Auth-lite login (the only unauthenticated route).
      if (method === "POST" && url.pathname === "/api/login") {
        const body = await readBody(req);
        const name = typeof body["name"] === "string" ? (body["name"] as string).trim() : "";
        if (!name) return json(res, 400, { error: "name required" });
        // W8: first password sets it; once set, logins require it. Users who
        // never provided a password stay password-less (legacy behavior).
        const password = typeof body["password"] === "string" ? (body["password"] as string) : "";
        const rec = passwords.get(name);
        if (rec) {
          const expected = Buffer.from(rec.hash, "hex");
          const got = Buffer.from(hashPassword(password, rec.salt), "hex");
          if (!password || expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
            return json(res, 401, { error: "invalid password" });
          }
        } else if (password) {
          const salt = crypto.randomBytes(16).toString("hex");
          passwords.set(name, { salt, hash: hashPassword(password, salt) });
          savePasswords();
        }
        let user = [...projections.users.values()].find((u) => u.kind === "human" && u.name === name);
        if (!user) {
          // W7: the first real human in the org is its admin. Synthetic
          // actors (routine, orchestrator) never count.
          const humans = [...projections.users.values()].filter(
            (u) => u.kind === "human" && u.id !== "routine" && u.id !== "orchestrator",
          );
          const role = humans.length === 0 ? "admin" : "member";
          user = { id: crypto.randomUUID(), name, kind: "human", role };
          emit(newEvent(org, user.id, { kind: EventKind.MemberAdded, userId: user.id, user }));
        }
        const token = crypto.randomBytes(24).toString("hex");
        sessions.set(token, { token, userId: user.id });
        saveSessions();
        return json(res, 200, { token, user });
      }

      // Everything else requires Authorization: Bearer <token>.
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session = sessions.get(token);
      if (!session) return json(res, 401, { error: "unauthorized" });
      const userId = session.userId;

      try {
        // GET /api/state
        if (method === "GET" && url.pathname === "/api/state") {
          const channels = [...projections.channels.values()].filter((c) => c.memberIds.includes(userId));
          return json(res, 200, {
            channels,
            roster: [...projections.users.values()],
            agents: [...projections.agents.values()],
            memory: [...projections.memory.values()],
            approvals: [...projections.approvals.values()],
            routines: [...projections.routines.values()],
            inbox: [...projections.inbox.values()],
            questions: [...projections.questions.values()],
            goals: [...projections.goals.values()],
            templates: [...projections.templates.values()],
            pipelines: [...projections.pipelines.values()],
            costs: projections.costs,
            teams: [...projections.teams.values()],
            connectors: [...projections.connectors.values()],
            providers: providerStatuses(),
            me: projections.users.get(userId) ?? null,
            transcripts: Object.fromEntries(channels.map((c) => [c.id, projections.transcripts.get(c.id) ?? []])),
          });
        }

        // POST /api/channels {name, space}
        if (method === "POST" && url.pathname === "/api/channels") {
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          const space = String(body["space"] ?? "general").trim();
          if (!name) return json(res, 400, { error: "name required" });
          const channel: Channel = { id: crypto.randomUUID(), name, space, memberIds: [userId] };
          emit(newEvent(org, userId, { kind: EventKind.ChannelCreated, channel }, channel.id));
          return json(res, 200, { channel });
        }

        // POST /api/channels/:id/messages {text}
        if (method === "POST" && parts[0] === "api" && parts[1] === "channels" && parts[3] === "messages" && parts.length === 4) {
          const channelId = parts[2]!;
          if (!isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          const body = await readBody(req);
          const text = String(body["text"] ?? "");
          if (!text) return json(res, 400, { error: "text required" });
          const ev = newEvent(org, userId, { kind: EventKind.Message, text }, channelId);
          emit(ev);
          return json(res, 200, { event: ev });
        }

        // POST /api/channels/:id/members {userId}
        if (method === "POST" && parts[0] === "api" && parts[1] === "channels" && parts[3] === "members" && parts.length === 4) {
          const channelId = parts[2]!;
          if (!isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          const body = await readBody(req);
          const newMemberId = String(body["userId"] ?? "");
          if (!projections.users.has(newMemberId)) return json(res, 404, { error: "unknown user" });
          emit(newEvent(org, userId, { kind: EventKind.MemberAdded, userId: newMemberId }, channelId));
          return json(res, 200, { ok: true });
        }

        // POST /api/agents {name, persona, driver, modelPolicy, channelId?}
        if (method === "POST" && url.pathname === "/api/agents") {
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          if (!name) return json(res, 400, { error: "name required" });
          const rawDriver = String(body["driver"] ?? "mock");
          const driver = (["anthropic", "managed", "foundry", "openai_compat"] as const).find((d) => d === rawDriver) ?? "mock";
          const mp = (body["modelPolicy"] ?? {}) as Partial<ModelPolicy>;
          const agentUser: User = { id: crypto.randomUUID(), name, kind: "agent" };
          const agent: AgentRecord = {
            id: agentUser.id,
            name,
            persona: String(body["persona"] ?? ""),
            driver,
            modelPolicy: {
              model: String(mp.model ?? "claude-haiku-4-5"),
              effort: String(mp.effort ?? "low"),
              maxTokens: Number(mp.maxTokens ?? 1024),
            },
            allowTools: Array.isArray(body["allowTools"]) ? (body["allowTools"] as unknown[]).map(String) : [],
          };
          if (Array.isArray(body["networkAllowlist"])) {
            agent.environment = { networkAllowlist: (body["networkAllowlist"] as unknown[]).map(String) };
          }
          const channelId = typeof body["channelId"] === "string" ? (body["channelId"] as string) : undefined;
          if (channelId && !isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          emit(newEvent(org, userId, { kind: EventKind.MemberAdded, userId: agent.id, user: agentUser, agent }, channelId));
          return json(res, 200, { agent });
        }

        // POST /api/approvals/:id {approve}
        if (method === "POST" && parts[0] === "api" && parts[1] === "approvals" && parts.length === 3) {
          const approval = projections.approvals.get(parts[2]!);
          if (!approval) return json(res, 404, { error: "unknown approval" });
          if (!isMember(approval.channelId, userId)) return json(res, 403, { error: "not a member" });
          const body = await readBody(req);
          const status = body["approve"] === true ? "approved" : "denied";
          emit(newEvent(org, userId, { kind: EventKind.ApprovalResolved, approvalId: approval.id, status, by: userId }, approval.channelId));
          return json(res, 200, { ok: true, status });
        }

        // POST /api/memory/:id/review {accept}
        if (method === "POST" && parts[0] === "api" && parts[1] === "memory" && parts[3] === "review" && parts.length === 4) {
          const entry = projections.memory.get(parts[2]!);
          if (!entry) return json(res, 404, { error: "unknown memory entry" });
          const body = await readBody(req);
          const accept = body["accept"] === true;
          const evBody: EventBody = accept
            ? { kind: EventKind.MemoryAccepted, entryId: entry.id, by: userId }
            : { kind: EventKind.MemoryRejected, entryId: entry.id, by: userId };
          emit(newEvent(org, userId, evBody, projections.memoryChannel.get(entry.id)));
          return json(res, 200, { ok: true, accepted: accept });
        }

        // POST /api/routines {name, agentId, channelId, prompt, schedule}
        if (method === "POST" && url.pathname === "/api/routines") {
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          const agentId = String(body["agentId"] ?? "");
          const channelId = String(body["channelId"] ?? "");
          const prompt = String(body["prompt"] ?? "").trim();
          if (!name || !prompt) return json(res, 400, { error: "name and prompt required" });
          if (!projections.agents.has(agentId)) return json(res, 404, { error: "unknown agent" });
          if (!isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          const rawSchedule = (body["schedule"] ?? {}) as Partial<{ kind: string; minutes: number }>;
          const schedule: RoutineSchedule =
            rawSchedule.kind === "interval"
              ? { kind: "interval", minutes: Math.max(0, Number(rawSchedule.minutes ?? 60)) }
              : { kind: "manual" };
          const routine: RoutineRecord = { id: crypto.randomUUID(), name, agentId, channelId, prompt, schedule };
          emit(newEvent(org, userId, { kind: EventKind.RoutineCreated, routine }, channelId));
          return json(res, 200, { routine });
        }

        // POST /api/routines/:id/run — manual trigger
        if (method === "POST" && parts[0] === "api" && parts[1] === "routines" && parts[3] === "run" && parts.length === 4) {
          const routine = projections.routines.get(parts[2]!);
          if (!routine) return json(res, 404, { error: "unknown routine" });
          if (!isMember(routine.channelId, userId)) return json(res, 403, { error: "not a member" });
          runRoutine(routine);
          return json(res, 200, { ok: true });
        }

        // ---- Wave 7 routes (E2/E3): RBAC, teams, connectors, DMs ----
        const isAdmin = projections.users.get(userId)?.role === "admin";

        // POST /api/teams {name}
        if (method === "POST" && url.pathname === "/api/teams") {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          if (!name) return json(res, 400, { error: "name required" });
          const team: TeamRecord = { id: crypto.randomUUID(), name, memberIds: [] };
          emit(newEvent(org, userId, { kind: EventKind.TeamCreated, team }));
          return json(res, 200, { team });
        }

        // POST /api/teams/:id/members {userId}
        if (method === "POST" && parts[0] === "api" && parts[1] === "teams" && parts[3] === "members" && parts.length === 4) {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const team = projections.teams.get(parts[2]!);
          if (!team) return json(res, 404, { error: "unknown team" });
          const body = await readBody(req);
          const memberId = String(body["userId"] ?? "");
          if (!projections.users.has(memberId)) return json(res, 404, { error: "unknown user" });
          emit(newEvent(org, userId, { kind: EventKind.TeamMemberAdded, teamId: team.id, userId: memberId }));
          return json(res, 200, { ok: true });
        }

        // POST /api/users/:id/role {role}
        if (method === "POST" && parts[0] === "api" && parts[1] === "users" && parts[3] === "role" && parts.length === 4) {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const target = projections.users.get(parts[2]!);
          if (!target || target.kind !== "human") return json(res, 404, { error: "unknown user" });
          const body = await readBody(req);
          const role = body["role"] === "admin" ? "admin" : "member";
          emit(newEvent(org, userId, { kind: EventKind.RoleChanged, userId: target.id, role, by: userId }));
          return json(res, 200, { ok: true });
        }

        // GET /api/connectors/catalog
        if (method === "GET" && url.pathname === "/api/connectors/catalog") {
          return json(res, 200, { catalog: PROVIDER_CATALOG.map(({ provider, label, defaultTools: dt }) => ({ provider, label, defaultTools: dt })) });
        }

        // POST /api/connectors {provider, kind, accessLevel?, scope?, teamId?}
        if (method === "POST" && url.pathname === "/api/connectors") {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const body = await readBody(req);
          const provider = String(body["provider"] ?? "");
          const info = providerInfo(provider);
          if (!info) return json(res, 404, { error: "unknown provider" });
          const connector: ConnectorRecord = {
            id: crypto.randomUUID(),
            provider,
            name: info.label,
            kind: body["kind"] === "memory" ? "memory" : "agent",
            status: "disconnected",
            accessLevel: body["accessLevel"] === "write_no_delete" ? "write_no_delete" : "read_only",
            tools: defaultTools(provider),
            scope: body["scope"] === "team" ? "team" : body["scope"] === "user" ? "user" : "org",
            syncedCount: 0,
          };
          if (typeof body["teamId"] === "string" && body["teamId"]) connector.teamId = body["teamId"] as string;
          // Memory connectors never write back — force read-only.
          if (connector.kind === "memory") connector.accessLevel = "read_only";
          emit(newEvent(org, userId, { kind: EventKind.ConnectorCreated, connector }));
          return json(res, 200, { connector });
        }

        // POST /api/connectors/:id {status?, tools?}
        if (method === "POST" && parts[0] === "api" && parts[1] === "connectors" && parts.length === 3) {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const connector = projections.connectors.get(parts[2]!);
          if (!connector) return json(res, 404, { error: "unknown connector" });
          const body = await readBody(req);
          const patch: { status?: "connected" | "disconnected"; tools?: ConnectorTool[] } = {};
          if (body["status"] === "connected" || body["status"] === "disconnected") patch.status = body["status"];
          if (Array.isArray(body["tools"])) {
            patch.tools = (body["tools"] as Array<Record<string, unknown>>).map((t) => ({
              name: String(t["name"] ?? ""),
              enabled: t["enabled"] === true,
            }));
          }
          emit(newEvent(org, userId, { kind: EventKind.ConnectorUpdated, connectorId: connector.id, ...patch }));
          return json(res, 200, { ok: true });
        }

        // POST /api/connectors/:id/sync — memory connectors only
        if (method === "POST" && parts[0] === "api" && parts[1] === "connectors" && parts[3] === "sync" && parts.length === 4) {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const connector = projections.connectors.get(parts[2]!);
          if (!connector) return json(res, 404, { error: "unknown connector" });
          if (connector.kind !== "memory") return json(res, 400, { error: "only memory connectors sync" });
          if (connector.status !== "connected") return json(res, 409, { error: "connector is disconnected" });
          const entries = syncItems(connector);
          emit(newEvent(org, userId, { kind: EventKind.ConnectorSynced, connectorId: connector.id, entries, ranAt: Date.now() }));
          return json(res, 200, { synced: entries.length });
        }

        // POST /api/dm {agentId} — find-or-create the 1:1 channel with an agent
        if (method === "POST" && url.pathname === "/api/dm") {
          const body = await readBody(req);
          const agentId = String(body["agentId"] ?? "");
          const agent = projections.agents.get(agentId);
          if (!agent) return json(res, 404, { error: "unknown agent" });
          const existing = [...projections.channels.values()].find(
            (c) => c.space === "dm" && c.memberIds.length === 2 && c.memberIds.includes(userId) && c.memberIds.includes(agentId),
          );
          if (existing) return json(res, 200, { channel: existing, created: false });
          const channel: Channel = { id: crypto.randomUUID(), name: agent.name, space: "dm", memberIds: [userId] };
          emit(newEvent(org, userId, { kind: EventKind.ChannelCreated, channel }, channel.id));
          emit(newEvent(org, userId, { kind: EventKind.MemberAdded, userId: agentId }, channel.id));
          return json(res, 200, { channel: projections.channels.get(channel.id), created: true });
        }

        // ---- Wave 6 routes ----

        // POST /api/inbox/:id/reply {reply}
        if (method === "POST" && parts[0] === "api" && parts[1] === "inbox" && parts[3] === "reply" && parts.length === 4) {
          const item = projections.inbox.get(parts[2]!);
          if (!item) return json(res, 404, { error: "unknown inbox item" });
          const body = await readBody(req);
          const reply = String(body["reply"] ?? "").trim();
          if (!reply) return json(res, 400, { error: "reply required" });
          emit(newEvent(org, userId, { kind: EventKind.InboxReplied, itemId: item.id, reply, by: userId }, item.channelId));
          // The reply also lands in the item's channel so the agent (and the room) sees it.
          if (item.channelId && isMember(item.channelId, userId)) {
            emit(newEvent(org, userId, { kind: EventKind.Message, text: reply }, item.channelId));
          }
          return json(res, 200, { ok: true });
        }

        // POST /api/questions/:id/answer {answer} — unblocks the agent's ask_user call
        if (method === "POST" && parts[0] === "api" && parts[1] === "questions" && parts[3] === "answer" && parts.length === 4) {
          const q = projections.questions.get(parts[2]!);
          if (!q) return json(res, 404, { error: "unknown question" });
          if (q.status !== "pending") return json(res, 409, { error: "already answered" });
          const body = await readBody(req);
          const answer = String(body["answer"] ?? "").trim();
          if (!answer) return json(res, 400, { error: "answer required" });
          if (q.options.length > 0 && !q.options.includes(answer)) {
            return json(res, 400, { error: "answer must be one of the options" });
          }
          emit(newEvent(org, userId, { kind: EventKind.QuestionAnswered, questionId: q.id, answer, by: userId }, q.channelId));
          return json(res, 200, { ok: true });
        }

        // POST /api/goals {name, spec, criteria: string[], agentId, channelId, guardrails?}
        if (method === "POST" && url.pathname === "/api/goals") {
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          const spec = String(body["spec"] ?? "").trim();
          const agentId = String(body["agentId"] ?? "");
          const channelId = String(body["channelId"] ?? "");
          const criteriaTexts = Array.isArray(body["criteria"]) ? (body["criteria"] as unknown[]).map(String) : [];
          if (!name || criteriaTexts.length === 0) return json(res, 400, { error: "name and criteria required" });
          if (!projections.agents.has(agentId)) return json(res, 404, { error: "unknown agent" });
          if (!isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          const rawG = (body["guardrails"] ?? {}) as Partial<GoalGuardrails>;
          const guardrails: GoalGuardrails = {
            maxSessions: Math.max(1, Number(rawG.maxSessions ?? 20)),
            spendCapUsd: Number(rawG.spendCapUsd ?? 25),
            wallClockMinutes: Math.max(1, Number(rawG.wallClockMinutes ?? 240)),
            stuckThreshold: Math.max(1, Number(rawG.stuckThreshold ?? 3)),
          };
          const goal: GoalRecord = {
            id: crypto.randomUUID(),
            name,
            spec,
            criteria: criteriaTexts.map((text, i) => ({ id: `c${i + 1}`, text, done: false })),
            guardrails,
            status: "running",
            sessions: 0,
            spentUsd: 0,
            startedAt: Date.now(),
            agentId,
            channelId,
          };
          emit(newEvent(org, userId, { kind: EventKind.GoalCreated, goal }, channelId));
          return json(res, 200, { goal });
        }

        // POST /api/templates {name, steps: [{title, agentId, prompt, requiresApproval}]}
        if (method === "POST" && url.pathname === "/api/templates") {
          const body = await readBody(req);
          const name = String(body["name"] ?? "").trim();
          const rawSteps = Array.isArray(body["steps"]) ? (body["steps"] as Array<Record<string, unknown>>) : [];
          if (!name || rawSteps.length === 0) return json(res, 400, { error: "name and steps required" });
          const steps: TemplateStep[] = rawSteps.map((s) => ({
            title: String(s["title"] ?? "step"),
            agentId: String(s["agentId"] ?? ""),
            prompt: String(s["prompt"] ?? ""),
            requiresApproval: s["requiresApproval"] === true,
          }));
          for (const s of steps) {
            if (!projections.agents.has(s.agentId)) return json(res, 404, { error: `unknown agent in step: ${s.title}` });
          }
          const template: TemplateRecord = { id: crypto.randomUUID(), name, steps };
          emit(newEvent(org, userId, { kind: EventKind.TemplateCreated, template }));
          return json(res, 200, { template });
        }

        // POST /api/pipelines {templateId, channelId, name?, input}
        if (method === "POST" && url.pathname === "/api/pipelines") {
          const body = await readBody(req);
          const template = projections.templates.get(String(body["templateId"] ?? ""));
          if (!template) return json(res, 404, { error: "unknown template" });
          const channelId = String(body["channelId"] ?? "");
          if (!isMember(channelId, userId)) return json(res, 403, { error: "not a member" });
          const run: PipelineRun = {
            id: crypto.randomUUID(),
            templateId: template.id,
            name: String(body["name"] ?? template.name),
            channelId,
            input: String(body["input"] ?? ""),
            stepIndex: 0,
            stepStates: template.steps.map(() => "pending"),
            status: "running",
          };
          emit(newEvent(org, userId, { kind: EventKind.PipelineStarted, run }, channelId));
          return json(res, 200, { run });
        }

        // POST /api/pipelines/:id/advance — human approves the gated step
        if (method === "POST" && parts[0] === "api" && parts[1] === "pipelines" && parts[3] === "advance" && parts.length === 4) {
          const run = projections.pipelines.get(parts[2]!);
          if (!run) return json(res, 404, { error: "unknown pipeline run" });
          if (!isMember(run.channelId, userId)) return json(res, 403, { error: "not a member" });
          const idx = run.stepStates.indexOf("awaiting_approval");
          if (idx < 0) return json(res, 409, { error: "no step awaiting approval" });
          emit(newEvent(org, userId, { kind: EventKind.PipelineStepCompleted, runId: run.id, stepIndex: idx, gated: false }, run.channelId));
          return json(res, 200, { ok: true });
        }

        // POST /api/import — admin-only: recreate agents/templates/routines from
        // an export-shaped JSON document (W8). Steps without agentId bind to the
        // first imported (or first existing) agent.
        if (method === "POST" && url.pathname === "/api/import") {
          if (!isAdmin) return json(res, 403, { error: "admin only" });
          const body = await readBody(req);
          const rawAgents = Array.isArray(body["agents"]) ? (body["agents"] as Array<Record<string, unknown>>) : [];
          const rawTemplates = Array.isArray(body["templates"]) ? (body["templates"] as Array<Record<string, unknown>>) : [];
          const rawRoutines = Array.isArray(body["routines"]) ? (body["routines"] as Array<Record<string, unknown>>) : [];
          const created = { agents: 0, templates: 0, routines: 0 };
          let firstImportedAgentId: string | undefined;
          for (const a of rawAgents) {
            const agentName = String(a["name"] ?? "").trim();
            if (!agentName) continue;
            const rawDriver = String(a["driver"] ?? "mock");
            const driver = (["anthropic", "managed", "foundry", "openai_compat"] as const).find((d) => d === rawDriver) ?? "mock";
            const agentUser: User = { id: crypto.randomUUID(), name: agentName, kind: "agent" };
            const agent: AgentRecord = {
              id: agentUser.id,
              name: agentName,
              persona: String(a["persona"] ?? ""),
              driver,
              modelPolicy: {
                model: String(a["model"] ?? "claude-haiku-4-5"),
                effort: String(a["effort"] ?? "low"),
                maxTokens: 1024,
              },
              allowTools: Array.isArray(a["allowTools"]) ? (a["allowTools"] as unknown[]).map(String) : [],
            };
            emit(newEvent(org, userId, { kind: EventKind.MemberAdded, userId: agent.id, user: agentUser, agent }));
            firstImportedAgentId ??= agent.id;
            created.agents++;
          }
          const bindAgentId = firstImportedAgentId ?? [...projections.agents.keys()][0];
          for (const t of rawTemplates) {
            const templateName = String(t["name"] ?? "").trim();
            const rawSteps = Array.isArray(t["steps"]) ? (t["steps"] as Array<Record<string, unknown>>) : [];
            if (!templateName || rawSteps.length === 0) continue;
            if (!bindAgentId) return json(res, 400, { error: "no agent to bind template steps to" });
            const steps: TemplateStep[] = rawSteps.map((s) => ({
              title: String(s["title"] ?? "step"),
              agentId:
                typeof s["agentId"] === "string" && projections.agents.has(s["agentId"] as string)
                  ? (s["agentId"] as string)
                  : bindAgentId,
              prompt: String(s["prompt"] ?? ""),
              requiresApproval: s["requiresApproval"] === true,
            }));
            emit(newEvent(org, userId, { kind: EventKind.TemplateCreated, template: { id: crypto.randomUUID(), name: templateName, steps } }));
            created.templates++;
          }
          for (const r of rawRoutines) {
            const routineName = String(r["name"] ?? "").trim();
            const prompt = String(r["prompt"] ?? "").trim();
            if (!routineName || !prompt) continue;
            if (!bindAgentId) return json(res, 400, { error: "no agent to bind routine to" });
            const rawSchedule = (r["schedule"] ?? {}) as Partial<{ kind: string; minutes: number }>;
            const schedule: RoutineSchedule =
              rawSchedule.kind === "interval"
                ? { kind: "interval", minutes: Math.max(0, Number(rawSchedule.minutes ?? 60)) }
                : { kind: "manual" };
            const agentId =
              typeof r["agentId"] === "string" && projections.agents.has(r["agentId"] as string)
                ? (r["agentId"] as string)
                : bindAgentId;
            const channelId = typeof r["channelId"] === "string" ? (r["channelId"] as string) : "";
            const routine: RoutineRecord = { id: crypto.randomUUID(), name: routineName, agentId, channelId, prompt, schedule };
            emit(newEvent(org, userId, { kind: EventKind.RoutineCreated, routine }, channelId || undefined));
            created.routines++;
          }
          return json(res, 200, { imported: created });
        }

        // GET /api/export — YAML of the org's operating config (W6-E)
        if (method === "GET" && url.pathname === "/api/export") {
          res.writeHead(200, { "content-type": "text/yaml" });
          res.end(exportYaml(projections));
          return;
        }

        return json(res, 404, { error: "not found" });
      } catch (err) {
        return json(res, 500, { error: String(err) });
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    try {
      resolveOrg(req.headers.host);
    } catch {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const session = sessions.get(url.searchParams.get("token") ?? "");
    if (!session) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sub: Sub = { ws, userId: session.userId, channels: new Set() };
      subs.add(sub);
      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          ws.send(JSON.stringify({ error: "bad json" }));
          return;
        }
        const channelId = typeof msg["subscribe"] === "string" ? (msg["subscribe"] as string) : "";
        if (!channelId) {
          ws.send(JSON.stringify({ error: "subscribe required" }));
          return;
        }
        // Membership check BEFORE registering the subscription (D3).
        if (!isMember(channelId, sub.userId)) {
          ws.send(JSON.stringify({ error: "not a member", channelId }));
          return;
        }
        sub.channels.add(channelId);
        ws.send(JSON.stringify({ subscribed: channelId }));
      });
      ws.on("close", () => subs.delete(sub));
    });
  });

  const listen = (port = Number(process.env["ATRIUM_PORT"] ?? 8900)): Promise<number> =>
    new Promise((resolve) => {
      server.listen(port, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(routineTimer);
      for (const sub of subs) sub.ws.terminate();
      wss.close();
      server.close(() => resolve());
    });

  const emitEvent = (authorId: string, body: EventBody, channelId?: string, opts: { ephemeral?: boolean } = {}): AtriumEvent => {
    const ev = newEvent("acme", authorId, body, channelId);
    emit(ev, opts);
    return ev;
  };

  return { server, listen, close, store, projections, emitEvent, tickRoutines };
}
