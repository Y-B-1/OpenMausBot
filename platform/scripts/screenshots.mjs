// screenshots: evidence gallery for the current build. Boots its own stack
// (same pattern as e2e-demo.mjs), seeds it with scripts/demo-seed.mjs, adds a
// live blocking question (presence chip) and a written file, then captures
// board / admin-connectors / memory-org / inbox / files / channel at
// 1440x900 in light+dark → web/screenshot-w8-<view>-<scheme>.png.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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
  if (!fs.existsSync(path.join(PLATFORM, "web/dist/index.html"))) {
    const build = spawnSync("corepack", ["pnpm", "run", "build:web"], { cwd: PLATFORM, stdio: "inherit" });
    if (build.status !== 0) throw new Error("web build failed");
  }
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-shots-"));
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
  return { relay, base, port };
}

async function nav(page, label) {
  await page.click(`.nav .nav-item:has-text("${label}")`);
}

async function sendMessage(page, text) {
  await page.fill(".composer input", text);
  await page.click('.composer button:has-text("Send")');
}

async function shoot(page, view, scheme) {
  const file = path.join(PLATFORM, "web", `screenshot-w8-${view}-${scheme}.png`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
  console.log(`shot: ${path.basename(file)}`);
}

async function main() {
  const { relay, base, port } = await bootStack();
  let browser = null;
  try {
    const seed = spawnSync(NODE_BIN, ["scripts/demo-seed.mjs"], {
      cwd: PLATFORM,
      env: { ...process.env, ATRIUM_PORT: String(port) },
      stdio: "inherit",
    });
    if (seed.status !== 0) throw new Error("demo seed failed");

    browser = await chromium.launch({ channel: "chrome" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.fill("#login-name", "Yosri");
    await page.click('button:has-text("Enter the atrium")');
    await page.waitForSelector('.nav-item:has-text("Inbox")', { timeout: 15000 });

    // A written file for the Files view (DM queue is free; colon-free form).
    await page.click('.dm-list button:has-text("Dev")');
    await page.waitForSelector(".composer input", { timeout: 10000 });
    await sendMessage(page, "save file launch-notes.md welcome to the Atrium workspace");
    await page.waitForSelector('.msg-text:has-text("Saved launch-notes.md")', { timeout: 15000 });

    // A live blocking question in a fresh channel → persistent presence chip.
    await page.fill('input[placeholder="New channel…"]', "standup");
    await page.click('button[title="Create channel"]');
    await page.click('.channel-item:has-text("standup")');
    await page.fill('.add-agent input[placeholder="Name"]', "Pulse");
    await page.click('button:has-text("Add agent")');
    await page.waitForSelector('.roster-row:has-text("Pulse")', { timeout: 10000 });
    await sendMessage(page, "@Pulse ask me which option");
    await page.waitForSelector('[data-testid="presence-chip"]', { timeout: 15000 });

    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });

      await page.waitForSelector('[data-testid="presence-chip"]', { timeout: 10000 });
      await shoot(page, "channel", scheme);

      await nav(page, "Board");
      await shoot(page, "board", scheme);

      await nav(page, "Inbox");
      await page.waitForSelector('[data-testid="question-card"]', { timeout: 10000 });
      await shoot(page, "inbox", scheme);

      await nav(page, "Memory");
      await page.waitForSelector(".mem-card", { timeout: 10000 });
      await shoot(page, "memory-org", scheme);

      await nav(page, "Files");
      await page.waitForSelector('[data-testid="file-row"]', { timeout: 10000 });
      await shoot(page, "files", scheme);

      await nav(page, "Admin");
      await page.click('.tab-row button:has-text("Connectors")');
      await page.waitForSelector('[data-testid="connector-card"]', { timeout: 10000 });
      await shoot(page, "admin-connectors", scheme);

      // Back to the live channel before the next scheme pass.
      await nav(page, "Channels");
      await page.click('.channel-item:has-text("standup")');
    }
    console.log("SCREENSHOTS OK");
  } finally {
    await browser?.close().catch(() => {});
    relay.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
