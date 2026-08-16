// e2e-demo: full-surface walkthrough of Atrium against a freshly booted stack.
// Usage: node scripts/e2e-demo.mjs [--only spaces|--only audit]
// Boots its own relay (ephemeral port, throwaway data dir), drives a real
// Chrome via playwright-core, hard-asserts every surface, exits 0 on success.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PLATFORM = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE_BIN = process.env.NODE_BIN ?? path.join(os.homedir(), ".nvm/versions/node/v22.22.2/bin/node");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

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
  if (!fs.existsSync(path.join(PLATFORM, "web/dist/index.html"))) {
    console.log("web/dist missing — building web…");
    const build = spawnSync("corepack", ["pnpm", "run", "build:web"], { cwd: PLATFORM, stdio: "inherit" });
    if (build.status !== 0) throw new Error("web build failed");
  }
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-e2e-"));
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
  return { relay, base, dataDir };
}

async function login(page, base, name) {
  await page.goto(base);
  await page.fill("#login-name", name);
  await page.click('button:has-text("Enter the atrium")');
  await page.waitForSelector('.nav-item:has-text("Inbox")', { timeout: 15000 });
}

async function nav(page, label) {
  await page.click(`.nav .nav-item:has-text("${label}")`);
}

async function sendMessage(page, text) {
  await page.fill(".composer input", text);
  await page.click('.composer button:has-text("Send")');
}

async function main() {
  const { relay, base, dataDir } = await bootStack();
  let browser = null;
  try {
    browser = await chromium.launch({ channel: "chrome" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // ---- Login as Boss (first human -> admin) ----
    await login(page, base, "Boss");
    await page.waitForSelector('.nav .nav-item:has-text("Admin")', { timeout: 10000 });
    assert(true, "login as Boss shows Admin nav (admin role)");

    // ---- Create channel "product" (space grouping) ----
    await page.fill('input[placeholder="New channel…"]', "product");
    await page.click('button[title="Create channel"]');
    await page.waitForSelector('.channel-item:has-text("product")', { timeout: 10000 });
    const spaceTitle = await page.waitForSelector('.rail-space-title[data-space="general"]', { timeout: 10000 });
    assert(!!spaceTitle, "sidebar groups channels under a space heading");

    // ---- Space page: heading opens the bundle view; channel row returns to chat ----
    await page.click('.rail-space-title[data-space="general"]');
    await page.waitForSelector('.page-head h2:has-text("Space · general")', { timeout: 10000 });
    await page.waitForSelector('[data-testid="space-channel-row"]:has-text("product")', { timeout: 10000 });
    assert(true, "space page lists the #product channel");
    await page.click('[data-testid="space-channel-row"]:has-text("product")');
    await page.waitForSelector('.chat-head h2:has-text("product")', { timeout: 10000 });
    assert(true, "space channel row opens the chat");

    if (only === "spaces") {
      console.log("E2E OK");
      return;
    }

    if (only !== "audit") {
      // ---- Add agent Dev (mock driver) via roster form ----
      await page.fill('.add-agent input[placeholder="Name"]', "Dev");
      await page.click('button:has-text("Add agent")');
      await page.waitForSelector('.roster-row:has-text("Dev")', { timeout: 10000 });
      assert(true, "agent Dev added to #product");

      // ---- Group chat @mention -> mock reply ----
      await sendMessage(page, "@Dev hello");
      await page.waitForSelector('.msg-text:has-text("You said")', { timeout: 15000 });
      assert(true, "@Dev replied in #product");

      // ---- DM the agent ----
      await page.click('.dm-list button:has-text("Dev")');
      await page.waitForSelector('.chat-space:has-text("direct message")', { timeout: 10000 });
      await sendMessage(page, "hello in private");
      await page.waitForSelector('.msg-text:has-text(\'You said: "hello in private"\')', { timeout: 15000 });
      assert(true, "DM with Dev gets a reply");

      // ---- Blocking question -> Inbox -> answer unblocks ----
      await sendMessage(page, "@Dev ask me which option");
      await nav(page, "Inbox");
      await page.waitForSelector('[data-testid="question-card"]', { timeout: 15000 });
      await page.click('[data-testid="question-card"] button:has-text("Option A")');
      await page.waitForSelector('[data-testid="question-card"] .chip:has-text("answered")', { timeout: 15000 });
      assert(true, "inbox question answered (Option A) and card shows answered");

      // ---- Goal loop to done ----
      await nav(page, "Goals");
      await page.fill('input[aria-label="Goal name"]', "Ship it");
      await page.selectOption('select[aria-label="Goal agent"]', { label: "@Dev" });
      await page.selectOption('select[aria-label="Goal channel"]', { label: "#product" });
      await page.fill('textarea[aria-label="Criteria"]', "Write the code\nShip the release");
      await page.click('button:has-text("Start goal")');
      await page.waitForSelector('.goal-card .chip:has-text("done")', { timeout: 30000 });
      assert(true, 'goal "Ship it" completed (status chip done)');

      // ---- Board shows the goal under Done ----
      await nav(page, "Board");
      await page.waitForSelector(
        '.board-col:has(.board-col-title:has-text("Done")) .board-card-title:has-text("Ship it")',
        { timeout: 10000 },
      );
      assert(true, "board shows Ship it under Done");

      // ---- Pipeline: template, run, gate, approve, done ----
      await nav(page, "Pipelines");
      await page.fill('input[placeholder="Template name"]', "Shipflow");
      await page.fill('textarea[aria-label="Steps"]', "Write spec | Produce spec | gate\nImplement | Implement.");
      await page.click('button:has-text("Create template")');
      await page.waitForSelector('select[aria-label="Template"] option', { state: "attached", timeout: 10000 });
      await page.selectOption('select[aria-label="Template"]', { label: "Shipflow" });
      await page.selectOption('select[aria-label="Channel"]', { label: "#product" });
      await page.fill('input[aria-label="Run input"]', "the demo feature");
      await page.click('button:has-text("Start run")');
      await page.waitForSelector('.pipeline-card .chip:has-text("awaiting approval")', { timeout: 20000 });
      await page.click('button:has-text("Approve & continue")');
      await page.waitForSelector('.pipeline-card .chip-status-done', { timeout: 20000 });
      assert(true, "pipeline gated, approved, and ran to done");

      // ---- Connector -> sync -> org memory shows handbook ----
      await nav(page, "Admin");
      await page.click('button:has-text("Connectors")');
      await page.selectOption('select[aria-label="Provider"]', "sharepoint");
      await page.selectOption('select[aria-label="Connector kind"]', "memory");
      await page.selectOption('select[aria-label="Connector scope"]', "org");
      await page.click('.form-card button:has-text("Add")');
      await page.waitForSelector('[data-testid="connector-card"]', { timeout: 10000 });
      await page.click('[data-testid="connector-card"] button:has-text("Connect")');
      await page.waitForSelector('[data-testid="connector-card"] .chip:has-text("connected")', { timeout: 10000 });
      await page.click('[data-testid="connector-card"] button:has-text("Sync now")');
      await page.waitForSelector('[data-testid="connector-card"] :has-text("items in memory")', { timeout: 10000 });
      await nav(page, "Memory");
      await page.waitForSelector('.mem-card .card-text:has-text("handbook")', { timeout: 10000 });
      assert(true, "SharePoint sync landed a handbook fact in Organization memory");

      // ---- Promote Sara (second browser context) to admin ----
      const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page2 = await ctx2.newPage();
      await login(page2, base, "Sara");
      const saraSeesAdmin = await page2.$('.nav .nav-item:has-text("Admin")');
      assert(!saraSeesAdmin, "Sara (member) does not see Admin nav");
      await nav(page, "Admin");
      await page.click('button:has-text("People")');
      await page.waitForSelector('.admin-row:has-text("Sara")', { timeout: 10000 });
      await page.click('.admin-row:has-text("Sara") button:has-text("Make admin")');
      await page.waitForSelector('.admin-row:has(.roster-name:has-text("Sara")) .chip:has-text("admin")', { timeout: 10000 });
      assert(true, "Sara promoted to admin (chip shows admin)");
      await ctx2.close();

      // ---- Costs: agent turns >= 1 ----
      await nav(page, "Costs");
      const turnsText = await page.textContent('.stat-card:has(.stat-label:has-text("agent turns")) .stat-value');
      assert(Number(turnsText) >= 1, `costs shows agent turns >= 1 (got ${turnsText})`);
    }

    // ---- Audit tab shows rows ----
    await nav(page, "Admin");
    await page.click('.tab-row button:has-text("Audit")');
    await page.waitForSelector('[data-testid="audit-row"]', { timeout: 10000 });
    const rows = await page.$$('[data-testid="audit-row"]');
    assert(rows.length >= 1, `audit tab shows ${rows.length} rows`);

    console.log("E2E OK");
  } finally {
    if (browser) await browser.close().catch(() => {});
    relay.kill();
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
