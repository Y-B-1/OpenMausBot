// demo-verify: boots a throwaway ephemeral-port stack, runs demo-seed.mjs
// against it, then hard-asserts via /api/state that every surface got data.
// Exit 0 = all PASS. Usage: node scripts/demo-verify.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE_BIN = process.env.NODE_BIN ?? path.join(os.homedir(), ".nvm/versions/node/v22.22.2/bin/node");

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function bootStack() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-demo-verify-"));
  const relay = spawn(NODE_BIN, ["--experimental-strip-types", "server/main.ts"], {
    cwd: PLATFORM,
    env: { ...process.env, ATRIUM_PORT: String(port), ATRIUM_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not start in 15s")), 15000);
    let out = "";
    relay.stdout.on("data", (d) => {
      out += String(d);
      const m = /listening on (http:\/\/localhost:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    relay.on("exit", (code) => reject(new Error(`relay exited early (${code})`)));
  });
  console.log(`relay up at ${base} (data ${dataDir})`);
  return { relay, base };
}

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
}

async function main() {
  const { relay, base } = await bootStack();
  try {
    const seed = spawnSync(NODE_BIN, ["scripts/demo-seed.mjs", "--base", base], { cwd: PLATFORM, stdio: "inherit" });
    check(seed.status === 0, "demo-seed.mjs exits 0");
    if (seed.status !== 0) return;

    const login = await (await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ name: "Yosri" }) })).json();
    const s = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${login.token}` } })).json();

    const rooms = s.channels.filter((c) => c.space !== "dm");
    check(rooms.length >= 6, `>=6 non-DM channels (got ${rooms.length})`);
    check(s.channels.filter((c) => c.space === "dm").length >= 2, "DM channels with Dev and Scout exist");
    check(s.agents.length === 4, `4 agents (got ${s.agents.length})`);
    check(s.teams.length === 3, `3 teams (got ${s.teams.length})`);
    check(s.roster.filter((u) => u.kind === "human" && !["routine", "orchestrator"].includes(u.id)).length === 4, "4 humans in the roster");
    check(s.memory.length >= 15, `>=15 memory entries (got ${s.memory.length})`);
    check(s.memory.filter((m) => m.trustTier === "agent_proposed").length === 2, "2 memory proposals pending review");
    check(s.memory.filter((m) => m.trustTier === "quarantined").length === 1, "1 quarantined memory proposal");
    check(s.memory.some((m) => m.trustTier === "human_confirmed" && m.kind === "lesson"), "an accepted lesson exists (self-review loop)");
    check(new Set(s.memory.map((m) => m.kind)).size >= 5, "memory spans >=5 kinds");
    check(s.goals.length >= 4, `>=4 goals (got ${s.goals.length})`);
    check(s.goals.filter((g) => g.status === "done").length === 3 && s.goals.filter((g) => g.status === "halted").length === 1, "3 done + 1 halted goal");
    check(s.pipelines.length >= 2, `>=2 pipeline runs (got ${s.pipelines.length})`);
    check(s.pipelines.filter((p) => p.stepStates.includes("awaiting_approval")).length === 2, "2 pipeline runs parked at a gate");
    check(s.pipelines.some((p) => p.status === "done"), "a pipeline run completed");
    check(s.routines.length === 2, `2 routines (got ${s.routines.length})`);
    check(s.connectors.length === 6, `6 connectors (got ${s.connectors.length})`);
    check(s.connectors.filter((c) => c.status === "connected").length === 4, "4 connectors connected, 2 disconnected");
    const jira = s.connectors.find((c) => c.provider === "jira");
    check(!!jira && jira.tools.filter((tool) => !tool.enabled).length === 2, "jira has 2 tools toggled off");
    check(s.questions.filter((q) => q.status === "pending").length === 1, "exactly 1 pending question (#approvals)");
    check(s.questions.filter((q) => q.status === "answered").length >= 2, "answered questions in the history");
    check(s.inbox.filter((i) => i.status === "open").length === 1, "exactly 1 open inbox item (Mailer)");
    check(s.approvals.filter((a) => a.status === "pending").length === 1, "exactly 1 pending sandbox approval (#platform)");
    check(s.approvals.some((a) => a.status === "approved"), "an approved sandbox exec exists (Computer page)");
    check(s.costs.length >= 20, `cost ledger has >=20 turns (got ${s.costs.length})`);

    const files = await (await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${login.token}` } })).json();
    check(files.files.length >= 3, `>=3 agent-written files (got ${files.files.length})`);

    // Idempotency: a second run is a no-op.
    const again = spawnSync(NODE_BIN, ["scripts/demo-seed.mjs", "--base", base], { cwd: PLATFORM, encoding: "utf8" });
    check(again.status === 0 && /already seeded/i.test(again.stdout), "second seed run is an idempotent no-op");
  } finally {
    relay.kill();
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nDEMO VERIFY OK" : `\nDEMO VERIFY FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(String(err?.stack ?? err));
    process.exit(1);
  });
