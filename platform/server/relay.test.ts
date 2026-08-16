import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { EventStore } from "./store.ts";
import { createRelay, resolveOrg, type Relay } from "./relay.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(): Promise<{ relay: Relay; base: string; port: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-relay-"));
  const relay = createRelay(new EventStore(dir));
  const port = await relay.listen(0); // ephemeral port, never fixed
  cleanups.push(async () => {
    await relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, base: `http://127.0.0.1:${port}`, port };
}

async function login(base: string, name: string): Promise<{ token: string; user: { id: string } }> {
  const res = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ name }) });
  return (await res.json()) as { token: string; user: { id: string } };
}

async function post(base: string, token: string, pathName: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  cleanups.push(() => ws.terminate());
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
  });
}

describe("resolveOrg", () => {
  it("maps localhost to acme and fails closed otherwise", () => {
    expect(resolveOrg("localhost:8900")).toBe("acme");
    expect(resolveOrg("127.0.0.1")).toBe("acme");
    expect(() => resolveOrg("evil.example.com")).toThrow();
    expect(() => resolveOrg(undefined)).toThrow();
  });
});

describe("relay", () => {
  it("scopes fan-out: member subscriber receives, non-member and unsubscribed do not", async () => {
    const { base, port } = await boot();
    const alice = await login(base, "alice");
    const bob = await login(base, "bob"); // never a member
    const carol = await login(base, "carol"); // member but not subscribed

    const chRes = await post(base, alice.token, "/api/channels", { name: "general", space: "hq" });
    const { channel } = (await chRes.json()) as { channel: { id: string } };
    await post(base, alice.token, `/api/channels/${channel.id}/members`, { userId: carol.user.id });

    const wsAlice = await connect(port, alice.token);
    const wsBob = await connect(port, bob.token);
    const wsCarol = await connect(port, carol.token);

    wsAlice.send(JSON.stringify({ subscribe: channel.id }));
    expect(await nextMessage(wsAlice)).toEqual({ subscribed: channel.id });

    const received: Record<string, unknown[]> = { alice: [], bob: [], carol: [] };
    wsAlice.on("message", (d) => received["alice"]!.push(JSON.parse(String(d))));
    wsBob.on("message", (d) => received["bob"]!.push(JSON.parse(String(d))));
    wsCarol.on("message", (d) => received["carol"]!.push(JSON.parse(String(d))));

    await post(base, alice.token, `/api/channels/${channel.id}/messages`, { text: "hi team" });
    await new Promise((r) => setTimeout(r, 100));

    expect(received["alice"]).toHaveLength(1);
    const first = received["alice"]![0] as { event: { body: { text: string } } };
    expect(first.event.body.text).toBe("hi team");
    expect(received["bob"]).toHaveLength(0);
    expect(received["carol"]).toHaveLength(0);
  });

  it("rejects subscribe for a non-member before registration", async () => {
    const { base, port } = await boot();
    const alice = await login(base, "alice");
    const mallory = await login(base, "mallory");
    const chRes = await post(base, alice.token, "/api/channels", { name: "private", space: "hq" });
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    const wsMallory = await connect(port, mallory.token);
    wsMallory.send(JSON.stringify({ subscribe: channel.id }));
    const reply = await nextMessage(wsMallory);
    expect(reply["error"]).toBe("not a member");

    // And no leakage afterwards either.
    const got: unknown[] = [];
    wsMallory.on("message", (d) => got.push(JSON.parse(String(d))));
    await post(base, alice.token, `/api/channels/${channel.id}/messages`, { text: "secret" });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(0);
  });

  it("enforces membership on POST message", async () => {
    const { base } = await boot();
    const alice = await login(base, "alice");
    const bob = await login(base, "bob");
    const chRes = await post(base, alice.token, "/api/channels", { name: "general", space: "hq" });
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    const denied = await post(base, bob.token, `/api/channels/${channel.id}/messages`, { text: "let me in" });
    expect(denied.status).toBe(403);
    const ok = await post(base, alice.token, `/api/channels/${channel.id}/messages`, { text: "fine" });
    expect(ok.status).toBe(200);
  });

  it("requires auth on non-login routes", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
  });

  it("projections rebuild from the log across relay restarts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-restart-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const relay1 = createRelay(new EventStore(dir));
    const port1 = await relay1.listen(0);
    const base1 = `http://127.0.0.1:${port1}`;
    const alice = await login(base1, "alice");
    const chRes = await post(base1, alice.token, "/api/channels", { name: "general", space: "hq" });
    const { channel } = (await chRes.json()) as { channel: { id: string } };
    await post(base1, alice.token, `/api/channels/${channel.id}/messages`, { text: "persisted" });
    await relay1.close();

    const relay2 = createRelay(new EventStore(dir));
    cleanups.push(() => relay2.close());
    expect(relay2.projections.transcripts.get(channel.id)!.map((t) => t.text)).toEqual(["persisted"]);
    expect(relay2.projections.channels.get(channel.id)!.name).toBe("general");
  });

  it("fans memory review outcomes out to the proposal's channel", async () => {
    const { relay, base, port } = await boot();
    const alice = await login(base, "alice");
    const chRes = await post(base, alice.token, "/api/channels", { name: "general", space: "hq" });
    const { channel } = (await chRes.json()) as { channel: { id: string } };

    relay.emitEvent(alice.user.id, {
      kind: 40,
      entry: {
        id: "m1",
        scope: "space",
        kind: "fact",
        content: "launch is in October",
        provenance: { author: alice.user.id, sessionRef: "s1" },
        trustTier: "agent_proposed",
        status: "active",
        ts: Date.now(),
      },
    } as never, channel.id);

    const ws = await connect(port, alice.token);
    ws.send(JSON.stringify({ subscribe: channel.id }));
    expect(await nextMessage(ws)).toEqual({ subscribed: channel.id });

    const received: unknown[] = [];
    ws.on("message", (d) => received.push(JSON.parse(String(d))));
    await post(base, alice.token, "/api/memory/m1/review", { accept: true });
    await new Promise((r) => setTimeout(r, 100));

    const kinds = received.map((m) => (m as { event: { kind: number } }).event.kind);
    expect(kinds).toContain(41);
  });
});
