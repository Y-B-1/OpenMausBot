// Atrium desktop shell — small self-contained Electron main.
// Launches (or attaches to) the Atrium relay server and shows its web UI.
import { app, BrowserWindow, dialog } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformDir = path.join(repoRoot, "platform");
const DEFAULT_PORT = 8900;

let relayChild = null;

function parseVersion(v) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionOk(v) {
  const p = parseVersion(v);
  if (!p) return false;
  return p[0] > 22 || (p[0] === 22 && (p[1] > 6 || (p[1] === 6 && p[2] >= 0)));
}

function nodeVersionOf(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function resolveNode() {
  const candidates = [];
  if (process.env.ATRIUM_NODE) candidates.push(process.env.ATRIUM_NODE);
  const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    const versions = readdirSync(nvmDir)
      .map((name) => ({ name, parsed: parseVersion(name) }))
      .filter((e) => e.parsed)
      .sort((a, b) =>
        b.parsed[0] - a.parsed[0] || b.parsed[1] - a.parsed[1] || b.parsed[2] - a.parsed[2]
      );
    for (const e of versions) candidates.push(path.join(nvmDir, e.name, "bin", "node"));
  }
  candidates.push("node");
  for (const bin of candidates) {
    const v = nodeVersionOf(bin);
    if (v && versionOk(v)) return bin;
  }
  return null;
}

function probeRelay(port) {
  return fetch(`http://localhost:${port}/api/state`)
    .then((res) => res.status === 200 || res.status === 401)
    .catch(() => false);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForRelay(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeRelay(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function fatal(title, message) {
  dialog.showErrorBox(title, message);
  app.quit();
}

async function start() {
  let port = DEFAULT_PORT;
  if (await probeRelay(DEFAULT_PORT)) {
    // Attach to the already-running relay; do not spawn (or kill) anything.
  } else {
    if (!existsSync(path.join(platformDir, "web", "dist", "index.html"))) {
      fatal(
        "equitiOS web UI not built",
        "platform/web/dist is missing.\n\nRun `corepack pnpm run build:web` in platform/ first."
      );
      return;
    }
    const nodeBin = resolveNode();
    if (!nodeBin) {
      fatal(
        "Node.js 22.6+ required",
        "equitiOS's relay server needs Node.js >= 22.6.\n\nInstall it (e.g. via nvm) or set ATRIUM_NODE to a suitable node binary."
      );
      return;
    }
    port = await freePort();
    const dataDir =
      process.env.ATRIUM_DATA_DIR ||
      path.join(os.homedir(), "Library", "Application Support", "equitiOS");
    mkdirSync(dataDir, { recursive: true });
    relayChild = spawn(nodeBin, ["--experimental-strip-types", "server/main.ts"], {
      cwd: platformDir,
      env: { ...process.env, ATRIUM_PORT: String(port), ATRIUM_DATA_DIR: dataDir },
      stdio: "ignore",
    });
    relayChild.on("exit", (code) => {
      relayChild = null;
      if (code !== 0 && !app.isQuitting) {
        fatal("equitiOS relay stopped", `The relay server exited unexpectedly (code ${code}).`);
      }
    });
    if (!(await waitForRelay(port))) {
      fatal("equitiOS relay did not start", "The relay server did not answer in time.");
      return;
    }
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "equitiOS",
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.on("page-title-updated", (e) => e.preventDefault()); // keep the shell titled equitiOS
  await win.loadURL(`http://localhost:${port}/`);
}

app.setName("equitiOS");

app.on("before-quit", () => {
  app.isQuitting = true;
  if (relayChild) {
    relayChild.kill();
    relayChild = null;
  }
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(start);
