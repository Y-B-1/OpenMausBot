// P9 audit log: hash-chain integrity, tamper detection, rotation, restart
// persistence — plus a booted-server pass over the instrumented route sites
// (goal create, template create, memory retire) proving mutations land as
// verifiable chain entries.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditManager, entryHash, GENESIS, type AuditEntry } from "./audit.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "omb-audit-"));

describe("audit chain", () => {
  it("chains entries by hash from genesis", () => {
    const audit = new AuditManager({ file: join(tmp(), "audit.ndjson"), now: () => 1000 });
    const a = audit.record({ actor: "alice", action: "goal.create", subject: "g1" });
    const b = audit.record({ action: "goal.pause", subject: "g1", detail: "lunch" });
    expect(a.prevHash).toBe(GENESIS);
    expect(b.prevHash).toBe(a.hash);
    expect(b.actor).toBe("system"); // no actor → system
    const { id: _i, hash, ...rest } = b;
    expect(entryHash(rest)).toBe(hash);
    expect(audit.verify()).toEqual({ valid: true, length: 2 });
  });

  it("survives a restart with the chain intact", () => {
    const file = join(tmp(), "audit.ndjson");
    const first = new AuditManager({ file });
    first.record({ action: "org.mode", subject: "on" });
    first.record({ action: "connector.add", subject: "github" });
    const reborn = new AuditManager({ file });
    expect(reborn.verify()).toEqual({ valid: true, length: 2 });
    expect(reborn.record({ action: "connector.sync", subject: "github" }).prevHash).toBe(
      reborn.list()[1].hash, // list is newest-first: [1] is connector.add
    );
    expect(reborn.verify().length).toBe(3);
  });

  it("verify pinpoints a tampered middle entry", () => {
    const file = join(tmp(), "audit.ndjson");
    const audit = new AuditManager({ file });
    for (let i = 0; i < 3; i++) audit.record({ action: "memory.accept", subject: `m${i}` });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
    lines[1].subject = "m1-forged"; // rewrite history without re-hashing
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const result = new AuditManager({ file }).verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, reason: "hash" });
  });

  it("verify catches a deleted middle entry as a broken link", () => {
    const file = join(tmp(), "audit.ndjson");
    const audit = new AuditManager({ file });
    for (let i = 0; i < 3; i++) audit.record({ action: "file.add", subject: `f${i}` });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    const result = new AuditManager({ file }).verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, reason: "link" });
  });

  it("rotates at the cap keeping the newest half verifiable", () => {
    const file = join(tmp(), "audit.ndjson");
    const audit = new AuditManager({ file, maxEntries: 10 });
    for (let i = 0; i < 15; i++) audit.record({ action: "goal.create", subject: `g${i}` });
    expect(audit.verify().valid).toBe(true);
    expect(audit.verify().length).toBeLessThanOrEqual(10);
    // the rotated file reloads verifiable too (head prevHash is trusted)
    expect(new AuditManager({ file, maxEntries: 10 }).verify().valid).toBe(true);
    const newest = audit.list({ limit: 1 })[0];
    expect(newest.subject).toBe("g14");
  });

  it("filters by dot-prefix", () => {
    const audit = new AuditManager({ file: join(tmp(), "audit.ndjson") });
    audit.record({ action: "goal.create", subject: "g" });
    audit.record({ action: "goalless.other", subject: "x" });
    audit.record({ action: "goal.cancel", subject: "g" });
    expect(audit.list({ action: "goal" }).map((e) => e.action)).toEqual(["goal.cancel", "goal.create"]);
  });
});

// ── instrumented sites, end to end ─────────────────────────────────────
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("audit recording from instrumented routes", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-adt-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        OMB_DATA_DIR: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (c) => (stderr += String(c)));
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 20_000);

  afterAll(() => {
    child?.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it("mutations land as chained audit entries and the chain verifies", async () => {
    const bots = await api("GET", "/api/bots");
    const botId = bots.body.bots[0].id as string;
    const goal = await api("POST", "/api/goals", {
      botId,
      name: "Audit me",
      criteria: ["done"],
      guardrails: { maxSessions: 1 },
    });
    expect(goal.status).toBe(201);
    const template = await api("POST", "/api/templates", {
      name: "Audit pipeline",
      steps: [{ title: "one", prompt: "p", botId }],
    });
    expect(template.status).toBe(201);
    const memory = await api("POST", "/api/memory", { content: "audit fact", author: "tester" });
    expect(memory.status).toBe(201);
    const retired = await api("DELETE", `/api/memory/${memory.body.entry.id}`);
    expect(retired.status).toBe(200);

    const audit = await api("GET", "/api/audit");
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as AuditEntry[]).map((e) => e.action);
    expect(actions).toContain("goal.create");
    expect(actions).toContain("pipeline.template.create");
    expect(actions).toContain("memory.retire");
    const filtered = await api("GET", "/api/audit?action=goal");
    expect((filtered.body.entries as AuditEntry[]).every((e) => e.action.startsWith("goal"))).toBe(true);

    const verify = await api("GET", "/api/audit/verify");
    expect(verify.body).toMatchObject({ valid: true });
    expect(verify.body.length).toBeGreaterThanOrEqual(3);
  }, 20_000);
});
