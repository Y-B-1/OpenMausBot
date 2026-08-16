// T9: SandboxProvider seam + LocalSandbox (allowlisted argv, no shell,
// scrubbed env, 10s timeout, capped output).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../store.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };

export interface Sandbox {
  exec(argv: string[]): Promise<ExecResult>;
  writeFile(name: string, content: string): Promise<void>;
  readFile(name: string): Promise<string>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  create(agentId: string): Sandbox;
}

const ALLOWED_BINARIES = new Set(["node", "ls", "cat", "echo", "wc"]);
const TIMEOUT_MS = 10_000;
const OUTPUT_CAP = 64 * 1024;

export class LocalSandbox implements Sandbox {
  readonly dir: string;

  constructor(agentId: string) {
    if (!/^[a-z0-9-]+$/i.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
    this.dir = path.join(dataDir(), "sandboxes", agentId);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private resolveInside(name: string): string {
    const p = path.resolve(this.dir, name);
    if (p !== this.dir && !p.startsWith(this.dir + path.sep)) {
      throw new Error(`path escapes sandbox: ${name}`);
    }
    return p;
  }

  exec(argv: string[]): Promise<ExecResult> {
    const bin = argv[0];
    if (!bin || !ALLOWED_BINARIES.has(bin)) {
      return Promise.reject(new Error(`binary not allowed: ${bin ?? "<none>"}`));
    }
    return new Promise((resolve, reject) => {
      // No shell; env scrubbed to PATH only.
      const child = spawn(bin, argv.slice(1), {
        cwd: this.dir,
        shell: false,
        env: { PATH: process.env["PATH"] ?? "" },
        timeout: TIMEOUT_MS,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8").slice(0, OUTPUT_CAP - stdout.length);
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8").slice(0, OUTPUT_CAP - stderr.length);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  async writeFile(name: string, content: string): Promise<void> {
    fs.writeFileSync(this.resolveInside(name), content, "utf8");
  }

  async readFile(name: string): Promise<string> {
    return fs.readFileSync(this.resolveInside(name), "utf8");
  }

  async destroy(): Promise<void> {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  private readonly cache = new Map<string, LocalSandbox>();

  create(agentId: string): Sandbox {
    let sb = this.cache.get(agentId);
    if (!sb) {
      sb = new LocalSandbox(agentId);
      this.cache.set(agentId, sb);
    }
    return sb;
  }
}
