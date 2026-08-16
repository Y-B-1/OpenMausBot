// Wave 8 tests: deployable auth (passwords + persisted sessions) and JSON import.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventKind, type AgentRecord, type GoalRecord, type TemplateRecord, type User } from "../shared/contracts.ts";
import { EventStore } from "./store.ts";
import { createRelay, type Relay } from "./relay.ts";
import { createDispatcher, type Dispatcher } from "./agents/dispatcher.ts";
import { createEngines, type Engines } from "./agents/engines.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env["ATRIUM_DATA_DIR"];
  process.env["ATRIUM_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w8-"));
  const dir = process.env["ATRIUM_DATA_DIR"]!;
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env["ATRIUM_DATA_DIR"];
    else process.env["ATRIUM_DATA_DIR"] = savedDataDir;
  });
});

async function boot(): Promise<{ relay: Relay; base: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w8-store-"));
  const relay = createRelay(new EventStore(dir));
  const port = await relay.listen(0);
  cleanups.push(async () => {
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, base: `http://127.0.0.1:${port}`, dir };
}

async function bootWithEngines(): Promise<{ relay: Relay; dispatcher: Dispatcher; engines: Engines; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w8-store-"));
  const relay = createRelay(new EventStore(dir));
  const dispatcher = createDispatcher(relay);
  const engines = createEngines(relay, dispatcher);
  const port = await relay.listen(0);
  cleanups.push(async () => {
    engines.dispose();
    dispatcher.dispose();
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, dispatcher, engines, base: `http://127.0.0.1:${port}` };
}

async function login(base: string, name: string, password?: string) {
  const body: Record<string, string> = { name };
  if (password !== undefined) body["password"] = password;
  const res = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, ...((await res.json()) as { token: string; user: User }) };
}

async function post(base: string, token: string, pathName: string, body: unknown = {}) {
  const res = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, token: string, pathName: string) {
  const res = await fetch(`${base}${pathName}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text() };
}

describe("auth deployable (W8)", () => {
  it("first login sets the password; wrong or missing password is 401 after", async () => {
    const { base } = await boot();
    const first = await login(base, "Yosri", "hunter2");
    expect(first.status).toBe(200);
    expect(first.user.role).toBe("admin");
    expect((await login(base, "Yosri", "wrong")).status).toBe(401);
    expect((await login(base, "Yosri")).status).toBe(401);
    const again = await login(base, "Yosri", "hunter2");
    expect(again.status).toBe(200);
    expect(again.user.id).toBe(first.user.id);
  });

  it("legacy password-less user stays password-less until they set one at login", async () => {
    const { base } = await boot();
    expect((await login(base, "Sara")).status).toBe(200);
    expect((await login(base, "Sara")).status).toBe(200); // still no password required
    expect((await login(base, "Sara", "s3cret")).status).toBe(200); // sets it
    expect((await login(base, "Sara")).status).toBe(401); // now required
    expect((await login(base, "Sara", "s3cret")).status).toBe(200);
  });

  it("passwords and session tokens survive a relay restart", async () => {
    const { relay, base, dir } = await boot();
    const admin = await login(base, "Yosri", "hunter2");
    expect((await get(base, admin.token, "/api/state")).status).toBe(200);
    await relay.close();

    // Same EventStore dir + same data dir: sessions and passwords reload.
    const relay2 = createRelay(new EventStore(dir));
    const port2 = await relay2.listen(0);
    cleanups.push(() => relay2.close());
    const base2 = `http://127.0.0.1:${port2}`;
    const state = await get(base2, admin.token, "/api/state");
    expect(state.status).toBe(200); // old token still authorized
    expect((await login(base2, "Yosri", "wrong")).status).toBe(401);
    expect((await login(base2, "Yosri", "hunter2")).status).toBe(200);
  });
});

describe("import (W8)", () => {
  it("round-trips agents and templates into a fresh relay via /api/import", async () => {
    const { relay: relayA, base: baseA } = await boot();
    const adminA = await login(baseA, "Yosri");
    const dev = (await post(baseA, adminA.token, "/api/agents", { name: "Dev", persona: "builds things" })).data["agent"] as { id: string; name: string };
    await post(baseA, adminA.token, "/api/templates", {
      name: "Ship",
      steps: [
        { title: "draft", agentId: dev.id, prompt: "write it", requiresApproval: false },
        { title: "review", agentId: dev.id, prompt: "check it", requiresApproval: true },
      ],
    });
    const exported = await get(baseA, adminA.token, "/api/export");
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("Ship");
    // Transform the export into the JSON import shape (agentIds dropped).
    const doc = {
      agents: [...relayA.projections.agents.values()].map((a) => ({ name: a.name, persona: a.persona, driver: a.driver, model: a.modelPolicy.model })),
      templates: [...relayA.projections.templates.values()].map((t) => ({
        name: t.name,
        steps: t.steps.map((s) => ({ title: s.title, prompt: s.prompt, requiresApproval: s.requiresApproval })),
      })),
    };

    const { relay: relayB, base: baseB } = await boot();
    const adminB = await login(baseB, "Boss");
    const imp = await post(baseB, adminB.token, "/api/import", doc);
    expect(imp.status).toBe(200);
    expect(imp.data["imported"]).toEqual({ agents: 1, templates: 1, routines: 0 });
    const agentB = [...relayB.projections.agents.values()].find((a) => a.name === "Dev")!;
    expect(agentB).toBeDefined();
    const templateB = [...relayB.projections.templates.values()].find((t) => t.name === "Ship") as TemplateRecord;
    expect(templateB.steps.map((s) => s.title)).toEqual(["draft", "review"]);
    expect(templateB.steps.map((s) => s.requiresApproval)).toEqual([false, true]);
    // Steps without agentId bind to the first imported agent.
    expect(templateB.steps.every((s) => s.agentId === agentB.id)).toBe(true);
  });

  it("audit: admin gets last events in append order, metadata only", async () => {
    const { base } = await boot();
    const admin = await login(base, "Yosri");
    await post(base, admin.token, "/api/channels", { name: "general", space: "general" });
    const res = await get(base, admin.token, "/api/audit");
    expect(res.status).toBe(200);
    const { events } = JSON.parse(res.text) as { events: Array<Record<string, unknown>> };
    expect(events.length).toBeGreaterThanOrEqual(2); // MemberAdded (login) + ChannelCreated
    // Append order: timestamps never decrease.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!["ts"] as number).toBeGreaterThanOrEqual(events[i - 1]![`ts`] as number);
    }
    expect(events.at(-1)!["kind"]).toBe(10); // ChannelCreated is the newest
    // No payload leakage: metadata keys only.
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        ["authorId", ...(e["channelId"] !== undefined ? ["channelId"] : []), "id", "kind", "ts"].sort(),
      );
    }
  });

  it("audit is admin-only: member gets 403", async () => {
    const { base } = await boot();
    await login(base, "Yosri"); // first human becomes admin
    const member = await login(base, "Sara");
    const res = await get(base, member.token, "/api/audit");
    expect(res.status).toBe(403);
  });

  it("self-review (E6): a completed goal lands an agent lesson in the memory review queue", async () => {
    const { relay, dispatcher, engines, base } = await bootWithEngines();
    const admin = await login(base, "Yosri");
    const { data: chData } = await post(base, admin.token, "/api/channels", { name: "ops", space: "general" });
    const ch = (chData["channel"] as { id: string }).id;
    const { data: agData } = await post(base, admin.token, "/api/agents", { name: "Dev", channelId: ch });
    const agent = agData["agent"] as AgentRecord;
    await post(base, admin.token, "/api/goals", {
      name: "Ship it",
      spec: "ship the thing",
      criteria: ["build the thing"],
      agentId: agent.id,
      channelId: ch,
    });
    await engines.settled();
    await dispatcher.idle(ch);
    const goal = [...relay.projections.goals.values()].find((g: GoalRecord) => g.name === "Ship it")!;
    expect(goal.status).toBe("done");
    // The mock driver's review handler proposed a lesson mentioning the goal.
    const proposal = [...relay.projections.memory.values()].find(
      (m) => m.provenance.author === agent.id && m.content.includes("Ship it"),
    );
    expect(proposal).toBeDefined();
    expect(["agent_proposed", "quarantined"]).toContain(proposal!.trustTier);
    expect(proposal!.status).toBe("active");
  });

  it("files (E6): GET /api/files lists FileWritten events for admin and member alike", async () => {
    const { dispatcher, base } = await bootWithEngines();
    const admin = await login(base, "Yosri");
    const { data: chData } = await post(base, admin.token, "/api/channels", { name: "docs", space: "general" });
    const ch = (chData["channel"] as { id: string }).id;
    const { data: agData } = await post(base, admin.token, "/api/agents", { name: "Scribe", channelId: ch });
    const agent = agData["agent"] as AgentRecord;
    await post(base, admin.token, `/api/channels/${ch}/messages`, { text: "@Scribe save file notes.md hello world" });
    await dispatcher.idle(ch);
    const res = await get(base, admin.token, "/api/files");
    expect(res.status).toBe(200);
    const { files } = JSON.parse(res.text) as { files: Array<{ agentId: string; name: string; bytes: number; ts: number }> };
    expect(files.length).toBe(1);
    expect(files[0]!.agentId).toBe(agent.id);
    expect(files[0]!.name).toBe("notes.md");
    expect(files[0]!.bytes).toBeGreaterThan(0);
    // Single org: members see the same list.
    const member = await login(base, "Sara");
    const memberRes = await get(base, member.token, "/api/files");
    expect(memberRes.status).toBe(200);
    expect((JSON.parse(memberRes.text) as { files: unknown[] }).files.length).toBe(1);
  });

  it("mock save-file: a trailing colon after the filename is not part of the name", async () => {
    const { dispatcher, base } = await bootWithEngines();
    const admin = await login(base, "Yosri");
    const { data: chData } = await post(base, admin.token, "/api/channels", { name: "docs", space: "general" });
    const ch = (chData["channel"] as { id: string }).id;
    await post(base, admin.token, "/api/agents", { name: "Scribe", channelId: ch });
    await post(base, admin.token, `/api/channels/${ch}/messages`, { text: "@Scribe save file notes.md: hello world" });
    await dispatcher.idle(ch);
    const res = await get(base, admin.token, "/api/files");
    const { files } = JSON.parse(res.text) as { files: Array<{ name: string }> };
    expect(files.length).toBe(1);
    expect(files[0]!.name).toBe("notes.md");
  });

  it("memory walls (E3): member of no team gets org + own personal entries only; admin sees all", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const sara = await login(base, "Sara"); // member, no team
    const team = (await post(base, admin.token, "/api/teams", { name: "Legal" })).data["team"] as { id: string };
    // Team-walled entries via a team-scoped memory connector sync (3 sharepoint items).
    const teamConn = (await post(base, admin.token, "/api/connectors", { provider: "sharepoint", kind: "memory", scope: "team", teamId: team.id })).data["connector"] as { id: string };
    await post(base, admin.token, `/api/connectors/${teamConn.id}`, { status: "connected" });
    await post(base, admin.token, `/api/connectors/${teamConn.id}/sync`);
    // Org entry via an org-scoped connector sync (1 onedrive item).
    const orgConn = (await post(base, admin.token, "/api/connectors", { provider: "onedrive", kind: "memory" })).data["connector"] as { id: string };
    await post(base, admin.token, `/api/connectors/${orgConn.id}`, { status: "connected" });
    await post(base, admin.token, `/api/connectors/${orgConn.id}/sync`);
    // Personal entries for Sara and for Yosri.
    const personal = (author: string, content: string) =>
      relay.emitEvent(author, {
        kind: EventKind.MemoryProposed,
        entry: {
          id: crypto.randomUUID(),
          scope: "personal",
          kind: "preference",
          content,
          provenance: { author, sessionRef: "test" },
          trustTier: "human_confirmed",
          status: "active",
          ts: Date.now(),
          source: "human",
        },
      } as never);
    personal(sara.user.id, "Sara prefers short updates");
    personal(admin.user.id, "Yosri prefers dashboards");

    const saraState = JSON.parse((await get(base, sara.token, "/api/state")).text) as { memory: Array<{ scope: string; teamId?: string; content: string }> };
    expect(saraState.memory.length).toBe(2); // 1 org + her own personal
    expect(saraState.memory.some((m) => m.scope === "org")).toBe(true);
    expect(saraState.memory.some((m) => m.content === "Sara prefers short updates")).toBe(true);
    expect(saraState.memory.some((m) => m.teamId === team.id)).toBe(false);
    expect(saraState.memory.some((m) => m.content === "Yosri prefers dashboards")).toBe(false);

    const adminState = JSON.parse((await get(base, admin.token, "/api/state")).text) as { memory: unknown[] };
    expect(adminState.memory.length).toBe(6); // 3 team + 1 org + 2 personal
  });

  it("connector re-scope (E3): admin flips scope after creation; FUTURE syncs follow the new partition", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const team = (await post(base, admin.token, "/api/teams", { name: "Legal" })).data["team"] as { id: string };
    const conn = (await post(base, admin.token, "/api/connectors", { provider: "onedrive", kind: "memory", scope: "team", teamId: team.id })).data["connector"] as { id: string };
    await post(base, admin.token, `/api/connectors/${conn.id}`, { status: "connected" });
    await post(base, admin.token, `/api/connectors/${conn.id}/sync`);
    const walled = [...relay.projections.memory.values()];
    expect(walled.every((m) => m.scope === "space" && m.teamId === team.id)).toBe(true);
    // Flip to org: the wall comes down for future syncs; past entries keep theirs.
    const flip = await post(base, admin.token, `/api/connectors/${conn.id}`, { scope: "org", teamId: null });
    expect(flip.status).toBe(200);
    const record = relay.projections.connectors.get(conn.id)!;
    expect(record.scope).toBe("org");
    expect(record.teamId).toBeUndefined();
    await post(base, admin.token, `/api/connectors/${conn.id}/sync`);
    const after = [...relay.projections.memory.values()];
    expect(after.length).toBe(walled.length * 2);
    expect(after.filter((m) => m.scope === "org" && m.teamId === undefined).length).toBe(walled.length);
  });

  it("import is admin-only: non-admin gets 403", async () => {
    const { base } = await boot();
    await login(base, "Yosri"); // first human becomes admin
    const member = await login(base, "Sara");
    const denied = await post(base, member.token, "/api/import", { agents: [{ name: "X" }] });
    expect(denied.status).toBe(403);
  });
});
