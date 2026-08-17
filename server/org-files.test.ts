// P9 files surface: base64 upload, soft retire (bytes stay), restart
// persistence, size cap, read-only workspace indexing with traversal guard.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OrgFilesManager } from "./org-files.ts";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "omb-files-"));
  const dir = join(root, "org-files");
  const workspacesDir = join(root, "workspaces");
  return { root, dir, workspacesDir };
};
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("org files", () => {
  it("uploads land on disk with metadata and download resolves", () => {
    const { dir, workspacesDir } = setup();
    const emitted: unknown[] = [];
    const files = new OrgFilesManager({ dir, workspacesDir, emit: (p) => emitted.push(p) });
    const meta = files.add({ name: "notes.md", dataBase64: b64("# hi"), mime: "text/markdown", uploader: "Sara" });
    expect(meta).toMatchObject({ name: "notes.md", size: 4, mime: "text/markdown", uploader: "Sara", source: "upload" });
    const content = files.contentFor(meta.id)!;
    expect(readFileSync(content.path, "utf8")).toBe("# hi");
    expect(emitted).toHaveLength(1);
    // restart keeps the index
    expect(new OrgFilesManager({ dir, workspacesDir }).list().map((f) => f.id)).toContain(meta.id);
  });

  it("retire is soft: flagged in the list, bytes stay, second retire is a no-op", () => {
    const { dir, workspacesDir } = setup();
    const files = new OrgFilesManager({ dir, workspacesDir });
    const meta = files.add({ name: "report.txt", dataBase64: b64("q3") });
    expect(files.retire(meta.id)).toMatchObject({ retired: true });
    expect(files.retire(meta.id)).toBeNull();
    expect(files.list().find((f) => f.id === meta.id)?.retired).toBe(true);
    expect(existsSync(files.contentFor(meta.id)!.path)).toBe(true);
  });

  it("rejects empty and oversized uploads, sanitizes hostile names", () => {
    const { dir, workspacesDir } = setup();
    const files = new OrgFilesManager({ dir, workspacesDir });
    expect(() => files.add({ name: "x", dataBase64: "" })).toThrow(/empty/);
    expect(() => files.add({ name: "x", dataBase64: b64("a".repeat(700_001)) })).toThrow(/too large/);
    const meta = files.add({ name: "../../etc/passwd", dataBase64: b64("x") });
    expect(meta.name).not.toContain("/");
  });

  it("indexes driver workspaces read-only and blocks traversal", () => {
    const { root, dir, workspacesDir } = setup();
    mkdirSync(join(workspacesDir, "bot-a"), { recursive: true });
    writeFileSync(join(workspacesDir, "bot-a", "out.txt"), "artifact");
    writeFileSync(join(root, "secret.txt"), "no");
    const files = new OrgFilesManager({ dir, workspacesDir });
    const ws = files.list().find((f) => f.source === "workspace");
    expect(ws).toMatchObject({ id: "ws:bot-a/out.txt", name: "out.txt", uploader: "bot-a" });
    expect(readFileSync(files.contentFor(ws!.id)!.path, "utf8")).toBe("artifact");
    expect(files.retire(ws!.id)).toBeNull(); // read-only
    expect(files.contentFor("ws:../secret.txt")).toBeNull();
  });
});
