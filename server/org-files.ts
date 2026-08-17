import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

// ── org files (P9) ─────────────────────────────────────────────────────
// A Files surface: artifacts humans share or agents produce. Uploads land
// as base64 JSON (upstream's API is JSON end to end; readBody caps bodies
// at 1MB, so the effective per-file cap is ~700KB — right-sized for notes,
// reports and small artifacts). Content lives under DATA_DIR/org-files/<id>
// with metadata in org-files.json; delete is RETIRE (soft) — bytes stay.
// Driver workspaces (DATA_DIR/workspaces/*, where CLI drivers default
// their cwd) are additionally indexed READ-ONLY: listed and downloadable,
// never retired or rewritten from here.

export interface OrgFileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  uploader: string;
  ts: number;
  botId?: string;
  retired?: boolean;
  source: "upload" | "workspace";
}

interface FilesFile {
  version: 1;
  files: OrgFileMeta[];
}

export interface OrgFilesManagerOptions {
  /** content + index root; defaults to DATA_DIR/org-files */
  dir?: string;
  /** read-only workspace root to index; defaults to DATA_DIR/workspaces */
  workspacesDir?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
}

const MAX_FILE_BYTES = 700_000; // fits the server's 1MB JSON body cap
const MAX_WORKSPACE_FILES = 200;
const MAX_WORKSPACE_DEPTH = 3;

const safeName = (name: string) =>
  (name.replace(/[/\\]/g, "_").trim() || "unnamed").slice(0, 120);

export class OrgFilesManager {
  private readonly dir: string;
  private readonly workspacesDir: string;
  private readonly index: string;
  private readonly now: () => number;
  private readonly options: OrgFilesManagerOptions;
  /** newest first */
  private files: OrgFileMeta[] = [];

  constructor(options: OrgFilesManagerOptions = {}) {
    this.options = options;
    this.dir = options.dir ?? join(DATA_DIR, "org-files");
    this.workspacesDir = options.workspacesDir ?? join(DATA_DIR, "workspaces");
    this.index = join(this.dir, "org-files.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.index, "utf8")) as Partial<FilesFile>;
      this.files = Array.isArray(disk.files) ? disk.files : [];
    } catch {
      this.files = [];
    }
  }

  add(input: {
    name?: unknown;
    dataBase64?: unknown;
    mime?: unknown;
    uploader?: unknown;
    botId?: unknown;
  }): OrgFileMeta {
    const name = safeName(String(input.name ?? ""));
    const data = Buffer.from(String(input.dataBase64 ?? ""), "base64");
    if (!data.length) throw new Error("empty file");
    if (data.length > MAX_FILE_BYTES) throw new Error("file too large (700KB max)");
    const meta: OrgFileMeta = {
      id: randomUUID(),
      name,
      size: data.length,
      mime: typeof input.mime === "string" && input.mime ? input.mime : "application/octet-stream",
      uploader: String(input.uploader ?? "").trim() || "you",
      ts: this.now(),
      ...(typeof input.botId === "string" && input.botId ? { botId: input.botId } : {}),
      source: "upload",
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, meta.id), data);
    this.files.unshift(meta);
    this.save();
    this.options.emit?.({ kind: "org_file", file: meta });
    return meta;
  }

  /** Soft delete: the row is flagged, the bytes stay on disk. */
  retire(id: string): OrgFileMeta | null {
    const meta = this.files.find((f) => f.id === id && !f.retired);
    if (!meta) return null;
    meta.retired = true;
    this.save();
    this.options.emit?.({ kind: "org_file", file: meta });
    return meta;
  }

  /** Uploads (incl. retired, flagged) + a read-only workspace scan. */
  list(): OrgFileMeta[] {
    return [...this.files.map((f) => ({ ...f })), ...this.scanWorkspaces()];
  }

  /** Resolve a file id to its on-disk path for download; null if unknown. */
  contentFor(id: string): { path: string; meta: OrgFileMeta } | null {
    const upload = this.files.find((f) => f.id === id);
    if (upload) return { path: join(this.dir, upload.id), meta: upload };
    if (id.startsWith("ws:")) {
      const rel = normalize(id.slice(3));
      if (rel.startsWith("..") || rel.startsWith(sep)) return null; // no traversal
      const path = join(this.workspacesDir, rel);
      const meta = this.scanWorkspaces().find((f) => f.id === id);
      return meta ? { path, meta } : null;
    }
    return null;
  }

  private scanWorkspaces(): OrgFileMeta[] {
    const found: OrgFileMeta[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > MAX_WORKSPACE_DEPTH || found.length >= MAX_WORKSPACE_FILES) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (found.length >= MAX_WORKSPACE_FILES) return;
        if (name.startsWith(".")) continue;
        const abs = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        try {
          const stat = statSync(abs);
          if (stat.isDirectory()) walk(abs, relPath, depth + 1);
          else if (stat.isFile()) {
            found.push({
              id: `ws:${relPath}`,
              name,
              size: stat.size,
              mime: "application/octet-stream",
              uploader: relPath.split("/")[0] ?? "workspace",
              ts: stat.mtimeMs,
              source: "workspace",
            });
          }
        } catch {}
      }
    };
    walk(this.workspacesDir, "", 0);
    return found.sort((a, b) => b.ts - a.ts);
  }

  private save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.index, JSON.stringify({ version: 1, files: this.files } satisfies FilesFile, null, 2));
  }
}
