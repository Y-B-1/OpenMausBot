// P12 e2e walkthrough: boots an ISOLATED upstream stack (scratch OMB_DATA_DIR,
// own port, OMB_STATIC_DIR=dist), runs a mock Anthropic Messages endpoint so
// bot turns are real-but-free, seeds the "Acme Digital" story via
// scripts/demo-seed.mjs, then drives a real Chrome (playwright-core) and
// hard-asserts every ported surface. Exits 0 only when every assert passed.
//
// Usage: corepack pnpm e2e:org        (needs Node >= 24 and Chrome installed)
// Never touches the live dev stack (8799/5199) — everything runs on its own
// ephemeral port with its own throwaway data dir.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// playwright-core lives in platform/ (the reference workspace), not the app's deps.
const { chromium } = createRequire(path.join(REPO, "platform/package.json"))("playwright-core");

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`Node ${process.versions.node} — this needs Node >= 24 (try ~/.nvm/versions/node/v24.14.0/bin/node).`);
  process.exit(1);
}

let passed = 0;
function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  passed += 1;
  console.log(`ok ${String(passed).padStart(2)}: ${label}`);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- Mock Anthropic Messages endpoint (SSE) — deterministic, free ----------
function mockReply(body) {
  const last = body.messages?.[body.messages.length - 1]?.content ?? "";
  if (/impossible/i.test(last)) return "Blocked: the vendor export API is sunset — no path forward this session.";
  if (/keep iterating/i.test(last)) return "Still iterating: drafted another revision, more passes needed.";
  if (/criterion marked \[>\]/.test(last)) return "DONE — completed the criterion and verified the result.";
  return "Acknowledged. Drafted the requested output for Acme Digital.";
}

function startMockAnthropic(port) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const text = mockReply(body);
      const usage = { input_tokens: 1200, output_tokens: 300 };
      setTimeout(() => {
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
          send({ type: "message_start", message: { usage: { input_tokens: usage.input_tokens } } });
          send({ type: "content_block_delta", delta: { type: "text_delta", text } });
          send({ type: "message_delta", usage: { output_tokens: usage.output_tokens }, delta: { stop_reason: "end_turn" } });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text }], usage, stop_reason: "end_turn" }));
        }
      }, 120);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ---- Stack -----------------------------------------------------------------
async function bootStack() {
  if (!fs.existsSync(path.join(REPO, "dist/index.html"))) {
    console.log("dist/ missing — building web…");
    const build = spawnSync("corepack", ["pnpm", "build"], { cwd: REPO, stdio: "inherit" });
    if (build.status !== 0) throw new Error("web build failed");
  }
  const mockPort = await freePort();
  const mock = await startMockAnthropic(mockPort);

  // SHORT scratch data dir (macOS unix-socket path cap — see UPSTREAM-TEST-BASELINE.md).
  const dataDir = fs.mkdtempSync("/tmp/omb-e2e-");
  // A config.json with `instances` REPLACES the default fleet: the only
  // provider in this stack is the mock — a real claude session is impossible.
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        "acme-mock": {
          driver: "anthropicApi",
          displayName: "Acme Mock",
          config: { url: `http://127.0.0.1:${mockPort}` },
          environment: { ANTHROPIC_API_KEY: "mock-key" },
        },
      },
    }),
  );

  const port = await freePort();
  const serverProc = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      OMB_DATA_DIR: dataDir,
      OMB_PORT: String(port),
      OMB_STATIC_DIR: path.join(REPO, "dist"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  serverProc.stdout.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not come up in 20s");
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`stack up at ${base} (data ${dataDir}, mock anthropic :${mockPort})`);
  return { serverProc, mock, base, dataDir };
}

function runSeeder(base) {
  // MUST be async: the mock Anthropic server lives in THIS process — a
  // spawnSync here would block the event loop and deadlock every bot turn.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/demo-seed.mjs", "--base", base, "--instance", "acme-mock", "--model", "claude-opus-5"],
      { cwd: REPO, stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`demo-seed failed (${code})`))));
  });
}

// ---- Walkthrough -----------------------------------------------------------
async function main() {
  const { serverProc, mock, base, dataDir } = await bootStack();
  let browser = null;
  let page = null;
  try {
    await runSeeder(base);

    browser = await chromium.launch({ channel: "chrome" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem("omb-email-gate", "skipped"));
    page = await ctx.newPage();
    await page.goto(base);
    const nav = async (label) => {
      await page.click(`aside button:has(span:text-is("${label}"))`);
      await page.waitForTimeout(300);
    };

    // 1. Sidebar groups + ported destinations render.
    await page.waitForSelector('aside :text-is("Work")', { timeout: 15_000 });
    for (const group of ["Work", "Knowledge", "Admin"]) {
      await page.waitForSelector(`aside :text-is("${group}")`, { timeout: 5_000 });
    }
    for (const label of ["Inbox", "Board", "Goals", "Pipelines", "Memory", "Connectors", "Files", "Costs"]) {
      await page.waitForSelector(`aside span:text-is("${label}")`, { timeout: 5_000 });
    }
    assert(true, "sidebar shows Work/Knowledge/Admin groups with all ported destinations");

    // 2-3. Inbox: items + answering the pending question settles it.
    await nav("Inbox");
    await page.waitForSelector(':text("Competitor scan is filed")', { timeout: 10_000 });
    assert(true, "inbox lists seeded items");
    await page.click(':text("Which rollout option for the session-store migration?")');
    await page.click('button:text-is("Option A — flag at 10%")');
    // The settled question leaves the "Needs you" filter; confirm server-side,
    // then find it again under Done showing its answer.
    const settled = await (async () => {
      for (let i = 0; i < 20; i++) {
        const { questions } = await fetch(`${base}/api/inbox`).then((r) => r.json());
        const q = questions.find((x) => x.prompt.startsWith("Which rollout option"));
        if (q?.status === "answered") return q;
        await page.waitForTimeout(250);
      }
      return null;
    })();
    assert(settled?.answer === "Option A — flag at 10%", "answering the pending inbox question settles it");
    await page.click('button:text-is("Done")');
    await page.click(':text("Which rollout option for the session-store migration?")');
    await page.waitForSelector(':text("Answered: Option A — flag at 10%")', { timeout: 5_000 });
    assert(true, "answered question shows its Answered chip under Done");

    // 4. Board: cards in >= 4 columns.
    await nav("Board");
    await page.waitForSelector(':text-is("Queued")', { timeout: 10_000 });
    const counts = await page.evaluate(() => {
      const labels = ["Queued", "In progress", "Waiting on human", "Done", "Halted"];
      const spans = [...document.querySelectorAll("span")];
      return labels.map((label) => {
        // column header: <span>{label}</span><span>{count}</span>
        const head = spans.find(
          (el) => el.textContent.trim() === label && el.nextElementSibling?.tagName === "SPAN",
        );
        return { label, count: Number((head?.nextElementSibling?.textContent ?? "0").trim()) };
      });
    });
    const nonEmpty = counts.filter((c) => c.count > 0);
    assert(
      nonEmpty.length >= 4,
      `board has cards in ${nonEmpty.length} columns (${nonEmpty.map((c) => `${c.label}:${c.count}`).join(", ")})`,
    );

    // 5-6. Goals: guardrail meters; halted goal shows its halt reason.
    await nav("Goals");
    // default "Active" filter auto-selects the paused goal; meters are visible
    await page.waitForSelector(':text-is("Guardrails")', { timeout: 10_000 });
    await page.waitForSelector(':text-is("Sessions")', { timeout: 5_000 });
    await page.waitForSelector(':text-is("Spend")', { timeout: 5_000 });
    assert(true, "goal detail shows guardrail meters (Sessions / Spend)");
    await page.click('button:text-is("All")');
    await page.click(':text-is("Migrate legacy CRM")');
    await page.waitForSelector(':text("Guardrail stop:")', { timeout: 10_000 });
    assert(true, "halted goal shows its guardrail halt reason");

    // 7. Pipelines: approve the gated run -> run advances to Done.
    await nav("Pipelines");
    await page.click(':text("Release notes — sprint 34"), :text-is("Release notes")');
    await page.waitForSelector(':text-is("Waiting for approval")', { timeout: 10_000 });
    await page.click('button:text-is("Approve")');
    await page.waitForSelector(':text-is("Done")', { timeout: 60_000 });
    assert(true, "approving the gated pipeline run advances it to Done");

    // 8-11. Memory: stat strip, review Accept, search filter, superseded strikethrough.
    await nav("Memory");
    await page.waitForSelector(':text-is("Ratified")', { timeout: 10_000 });
    await page.waitForSelector(':text-is("Confirmed")', { timeout: 5_000 });
    assert(true, "memory stat strip renders (Confirmed / Ratified)");
    await page.waitForSelector(':text("Review queue — waiting for you")', { timeout: 5_000 });
    const acceptTarget = ':text("SAML clock skew was the root cause")';
    await page.click(`div:has(> div ${acceptTarget}) button:text-is("Accept"), button:text-is("Accept")`);
    await page.waitForTimeout(500);
    const accepted = await fetch(`${base}/api/memory`).then((r) => r.json());
    assert(
      accepted.entries.some(
        (e) => e.trustTier === "human_confirmed" && /root cause|status\.vendor/.test(e.content),
      ),
      "review Accept moves an entry to the Confirmed tier",
    );
    await page.fill('input[placeholder="Search memory…"]', "gold tables");
    await page.waitForSelector(':text("curated Databricks datasets")', { timeout: 5_000 });
    const visible = await page.locator(':text("Sprint 34 priorities")').count();
    assert(visible === 0, 'search "gold tables" filters the list to matching entries');
    await page.fill('input[placeholder="Search memory…"]', "");
    await page.waitForSelector('.line-through:text("Fridays after 15:00"), :text-is("superseded")', { timeout: 5_000 });
    assert(true, "superseded entry renders struck-through with a superseded tag");

    // 12-13. Connectors: status pills + tool toggle flips.
    await nav("Connectors");
    await page.waitForSelector(':text-is("Connected")', { timeout: 10_000 });
    await page.waitForSelector(':text-is("Disconnected")', { timeout: 5_000 });
    assert(true, "connectors list shows Connected / Disconnected status pills");
    await page.click(':text-is("Jira")');
    const jiraBefore = (await fetch(`${base}/api/org-connectors`).then((r) => r.json())).connectors.find(
      (c) => c.provider === "jira",
    );
    const offTool = jiraBefore.tools.find((t) => !t.enabled);
    await page.waitForSelector('button[role="switch"]', { timeout: 5_000 });
    await page.click(`label:has(span:text-is("${offTool.name}")) button[role="switch"]`);
    await page.waitForTimeout(500);
    const jiraAfter = (await fetch(`${base}/api/org-connectors`).then((r) => r.json())).connectors.find(
      (c) => c.provider === "jira",
    );
    assert(
      jiraAfter.tools.find((t) => t.name === offTool.name).enabled === true,
      `tool toggle flips ${offTool.name} back on (verified via API)`,
    );

    // 14. Files: both uploads listed.
    await nav("Files");
    await page.waitForSelector(':text-is("release-checklist.md")', { timeout: 10_000 });
    await page.waitForSelector(':text-is("q3-competitor-scan.md")', { timeout: 5_000 });
    assert(true, "files page lists both uploaded files");

    // 15. Costs: stat cards + per-bot bars (real computed mock spend).
    await nav("Costs");
    await page.waitForSelector(':text-is("Today")', { timeout: 10_000 });
    await page.waitForSelector(':text-is("All time")', { timeout: 5_000 });
    await page.waitForSelector(':text("Acme Dev"), :text("Acme Scout")', { timeout: 5_000 });
    const costs = await fetch(`${base}/api/costs`).then((r) => r.json());
    assert(
      costs.summary.totals.turns >= 3 && costs.summary.totals.allTimeUsd > 0 && costs.summary.byBot.length >= 2,
      `costs shows stat cards + per-bot bars (${costs.summary.totals.turns} turns, $${costs.summary.totals.allTimeUsd.toFixed(4)}, ${costs.summary.byBot.length} bots)`,
    );

    // 16-17. Admin: audit chain verified; export bundle is non-empty JSON.
    await nav("Admin");
    await page.click('button:text-is("Audit log")');
    await page.waitForSelector(':text("Chain verified")', { timeout: 10_000 });
    assert(true, "admin audit tab shows the chain-verified badge");
    const { bundle } = await fetch(`${base}/api/org-export`).then((r) => r.json());
    for (const key of ["version", "inbox", "goals", "pipelines", "memory", "orgConnectors", "costs", "orgFiles", "audit"]) {
      if (!(key in bundle)) throw new Error(`export bundle missing key: ${key}`);
    }
    assert(
      bundle.goals.length >= 3 && bundle.memory.length >= 6 && bundle.audit.length >= 5,
      `org export bundle has all sections with content (${bundle.goals.length} goals, ${bundle.memory.length} memory, ${bundle.audit.length} audit rows)`,
    );

    // Final evidence screenshot (Board — the most cross-cutting view).
    await nav("Board");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(REPO, "platform/web/screenshot-p12-walkthrough.png"), fullPage: false });

    console.log(`\nE2E OK — ${passed} assertions passed. Screenshot: platform/web/screenshot-p12-walkthrough.png`);
  } catch (err) {
    // Failure evidence for debugging — never committed as the pass screenshot.
    if (page) await page.screenshot({ path: "/tmp/omb-p12-failure.png" }).catch(() => {});
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    serverProc.kill();
    mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err?.stack ?? err));
    process.exit(1);
  },
);
