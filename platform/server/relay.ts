// Atrium relay (T3): node:http + ws, auth-lite, fail-closed org resolution,
// event pipeline: authenticate → membership check → append → fan-out →
// projections fold → side-effect hooks.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AgentRecord,
  AtriumEvent,
  Channel,
  EventBody,
  ModelPolicy,
  User,
} from "../shared/contracts.ts";
import { EventKind } from "../shared/contracts.ts";
import { EventStore, Projections } from "./store.ts";

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
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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

      // Auth-lite login (the only unauthenticated route).
      if (method === "POST" && url.pathname === "/api/login") {
        const body = await readBody(req);
        const name = typeof body["name"] === "string" ? (body["name"] as string).trim() : "";
        if (!name) return json(res, 400, { error: "name required" });
        let user = [...projections.users.values()].find((u) => u.kind === "human" && u.name === name);
        if (!user) {
          user = { id: crypto.randomUUID(), name, kind: "human" };
          emit(newEvent(org, user.id, { kind: EventKind.MemberAdded, userId: user.id, user }));
        }
        const token = crypto.randomBytes(24).toString("hex");
        sessions.set(token, { token, userId: user.id });
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
          const driver = body["driver"] === "anthropic" ? "anthropic" : "mock";
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
            allowTools: [],
          };
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
          emit(newEvent(org, userId, evBody));
          return json(res, 200, { ok: true, accepted: accept });
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
      for (const sub of subs) sub.ws.terminate();
      wss.close();
      server.close(() => resolve());
    });

  const emitEvent = (authorId: string, body: EventBody, channelId?: string, opts: { ephemeral?: boolean } = {}): AtriumEvent => {
    const ev = newEvent("acme", authorId, body, channelId);
    emit(ev, opts);
    return ev;
  };

  return { server, listen, close, store, projections, emitEvent };
}
