// Wave 7 tests: roles/teams (E3), connectors + memory ingest (E2), DMs (E1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Channel, ConnectorRecord, TeamRecord, User } from "../shared/contracts.ts";
import { EventStore } from "./store.ts";
import { createRelay, type Relay } from "./relay.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let savedDataDir: string | undefined;
beforeEach(() => {
  savedDataDir = process.env["ATRIUM_DATA_DIR"];
  process.env["ATRIUM_DATA_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w7-"));
  const dir = process.env["ATRIUM_DATA_DIR"]!;
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env["ATRIUM_DATA_DIR"];
    else process.env["ATRIUM_DATA_DIR"] = savedDataDir;
  });
});

async function boot(): Promise<{ relay: Relay; base: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-w7-store-"));
  const relay = createRelay(new EventStore(dir));
  const port = await relay.listen(0);
  cleanups.push(async () => {
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, base: `http://127.0.0.1:${port}` };
}

async function login(base: string, name: string) {
  const res = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ name }) });
  return (await res.json()) as { token: string; user: User };
}

async function post(base: string, token: string, pathName: string, body: unknown = {}) {
  const res = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe("roles + teams (E3)", () => {
  it("first human is admin, later humans are members; admin can promote", async () => {
    const { base } = await boot();
    const first = await login(base, "Yosri");
    const second = await login(base, "Sara");
    expect(first.user.role).toBe("admin");
    expect(second.user.role).toBe("member");
    // Member cannot create teams or change roles.
    const denied = await post(base, second.token, "/api/teams", { name: "Ops" });
    expect(denied.status).toBe(403);
    // Admin promotes the member.
    const promote = await post(base, first.token, `/api/users/${second.user.id}/role`, { role: "admin" });
    expect(promote.status).toBe(200);
    const allowed = await post(base, second.token, "/api/teams", { name: "Ops" });
    expect(allowed.status).toBe(200);
  });

  it("admin creates a team and adds members", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const member = await login(base, "Sara");
    const { data } = await post(base, admin.token, "/api/teams", { name: "Finance" });
    const team = data["team"] as TeamRecord;
    await post(base, admin.token, `/api/teams/${team.id}/members`, { userId: member.user.id });
    expect(relay.projections.teams.get(team.id)!.memberIds).toContain(member.user.id);
  });
});

describe("connectors (E2)", () => {
  it("memory connector is forced read-only, syncs org-ratified connector-source memory", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const { data } = await post(base, admin.token, "/api/connectors", {
      provider: "sharepoint",
      kind: "memory",
      accessLevel: "write_no_delete", // must be overridden to read_only
    });
    const connector = data["connector"] as ConnectorRecord;
    expect(connector.accessLevel).toBe("read_only");
    // Sync while disconnected is refused.
    const refused = await post(base, admin.token, `/api/connectors/${connector.id}/sync`);
    expect(refused.status).toBe(409);
    // Connect, then sync.
    await post(base, admin.token, `/api/connectors/${connector.id}`, { status: "connected" });
    const sync = await post(base, admin.token, `/api/connectors/${connector.id}/sync`);
    expect(sync.status).toBe(200);
    const synced = [...relay.projections.memory.values()].filter((m) => m.source === "connector");
    expect(synced.length).toBeGreaterThan(0);
    // Connector-sourced entries skip the review queue entirely.
    expect(synced.every((m) => m.trustTier === "org_ratified" && m.status === "active")).toBe(true);
    expect(relay.projections.connectors.get(connector.id)!.syncedCount).toBe(synced.length);
  });

  it("agent connector keeps per-tool toggles; non-admin cannot touch connectors", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const member = await login(base, "Sara");
    const { data } = await post(base, admin.token, "/api/connectors", {
      provider: "jira",
      kind: "agent",
      accessLevel: "write_no_delete",
    });
    const connector = data["connector"] as ConnectorRecord;
    expect(connector.accessLevel).toBe("write_no_delete");
    expect(connector.tools.map((t) => t.name)).toContain("create_issue");
    // Toggle off write tools.
    const tools = connector.tools.map((t) => ({ ...t, enabled: !/create|comment/.test(t.name) }));
    await post(base, admin.token, `/api/connectors/${connector.id}`, { tools });
    const stored = relay.projections.connectors.get(connector.id)!;
    expect(stored.tools.find((t) => t.name === "create_issue")!.enabled).toBe(false);
    expect(stored.tools.find((t) => t.name === "search_issues")!.enabled).toBe(true);
    const denied = await post(base, member.token, `/api/connectors/${connector.id}`, { status: "connected" });
    expect(denied.status).toBe(403);
  });

  it("team-scoped memory connector stamps teamId on synced entries", async () => {
    const { relay, base } = await boot();
    const admin = await login(base, "Yosri");
    const teamRes = await post(base, admin.token, "/api/teams", { name: "Engineering" });
    const team = teamRes.data["team"] as TeamRecord;
    const { data } = await post(base, admin.token, "/api/connectors", {
      provider: "confluence",
      kind: "memory",
      scope: "team",
      teamId: team.id,
    });
    const connector = data["connector"] as ConnectorRecord;
    await post(base, admin.token, `/api/connectors/${connector.id}`, { status: "connected" });
    await post(base, admin.token, `/api/connectors/${connector.id}/sync`);
    const synced = [...relay.projections.memory.values()].filter((m) => m.source === "connector");
    expect(synced.every((m) => m.scope === "space" && m.teamId === team.id)).toBe(true);
  });
});

describe("DMs (E1)", () => {
  it("find-or-create returns the same 1:1 channel on repeat calls", async () => {
    const { base } = await boot();
    const admin = await login(base, "Yosri");
    const agentRes = await post(base, admin.token, "/api/agents", { name: "Dev" });
    const agent = agentRes.data["agent"] as { id: string };
    const first = await post(base, admin.token, "/api/dm", { agentId: agent.id });
    const second = await post(base, admin.token, "/api/dm", { agentId: agent.id });
    const ch1 = first.data["channel"] as Channel;
    const ch2 = second.data["channel"] as Channel;
    expect(first.data["created"]).toBe(true);
    expect(second.data["created"]).toBe(false);
    expect(ch1.id).toBe(ch2.id);
    expect(ch1.space).toBe("dm");
    expect(ch1.memberIds).toHaveLength(2);
  });
});
