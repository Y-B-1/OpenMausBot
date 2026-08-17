import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryManager } from "./memory.ts";
import { OrgConnectorManager, PROVIDER_CATALOG, constrainAccessLevel } from "./org-connectors.ts";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-orgconn-"));
  dirs.push(dir);
  return dir;
}

function harness() {
  const dir = tempDir();
  const emitted: any[] = [];
  const emit = (payload: unknown) => emitted.push(payload);
  const memory = new MemoryManager({ file: join(dir, "memory.json"), emit });
  const manager = new OrgConnectorManager({ memory, file: join(dir, "org-connectors.json"), emit });
  return { manager, memory, emitted, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("catalog + add", () => {
  it("serves the provider catalog", () => {
    const { manager } = harness();
    expect(manager.catalog().map((p) => p.provider)).toEqual(PROVIDER_CATALOG.map((p) => p.provider));
  });

  it("rejects unknown providers", () => {
    const { manager } = harness();
    expect(() => manager.add({ provider: "notion" })).toThrow(/Unknown provider/);
  });

  it("adds disconnected with the provider's default tools enabled", () => {
    const { manager } = harness();
    const connector = manager.add({ provider: "jira", kind: "agent" });
    expect(connector.status).toBe("disconnected");
    expect(connector.tools).toEqual([
      { name: "search_issues", enabled: true },
      { name: "read_issue", enabled: true },
      { name: "create_issue", enabled: true },
      { name: "comment", enabled: true },
    ]);
  });
});

describe("access-level enforcement", () => {
  it("memory connectors are strictly read_only, whatever was requested", () => {
    const { manager } = harness();
    const connector = manager.add({ provider: "sharepoint", kind: "memory", accessLevel: "write_no_delete" });
    expect(connector.accessLevel).toBe("read_only");
    expect(manager.configure(connector.id, { accessLevel: "write_no_delete" })!.accessLevel).toBe("read_only");
  });

  it("agent connectors allow write_no_delete but nothing beyond", () => {
    const { manager } = harness();
    const connector = manager.add({ provider: "github", kind: "agent", accessLevel: "write_no_delete" });
    expect(connector.accessLevel).toBe("write_no_delete");
    // anything unrecognized (e.g. a delete-capable level) falls back to read_only
    expect(manager.configure(connector.id, { accessLevel: "full" })!.accessLevel).toBe("read_only");
    expect(constrainAccessLevel("agent", "delete")).toBe("read_only");
  });
});

describe("tool toggles", () => {
  it("toggles a single tool and persists it", () => {
    const { manager, dir, memory } = harness();
    const connector = manager.add({ provider: "outlook", kind: "agent" });
    const updated = manager.setTool(connector.id, "draft_reply", false)!;
    expect(updated.tools.find((t) => t.name === "draft_reply")!.enabled).toBe(false);
    expect(updated.tools.find((t) => t.name === "search_mail")!.enabled).toBe(true);
    // reload from disk
    const reloaded = new OrgConnectorManager({ memory, file: join(dir, "org-connectors.json") });
    expect(reloaded.get(connector.id)!.tools.find((t) => t.name === "draft_reply")!.enabled).toBe(false);
  });

  it("returns null for unknown tools or connectors", () => {
    const { manager } = harness();
    const connector = manager.add({ provider: "onedrive" });
    expect(manager.setTool(connector.id, "nope", false)).toBeNull();
    expect(manager.setTool("missing", "read_file", false)).toBeNull();
  });
});

describe("sync", () => {
  it("requires a connected memory-kind connector", () => {
    const { manager } = harness();
    const connector = manager.add({ provider: "sharepoint", kind: "memory" });
    expect(manager.sync(connector.id)).toBeNull(); // disconnected
    const agent = manager.add({ provider: "github", kind: "agent" });
    manager.connect(agent.id);
    expect(manager.sync(agent.id)).toBeNull(); // agent kind never syncs memory
  });

  it("ingests sample items as org_ratified connector-source memory", () => {
    const { manager, memory } = harness();
    const connector = manager.add({ provider: "sharepoint", kind: "memory" });
    manager.connect(connector.id);
    const result = manager.sync(connector.id)!;
    expect(result.ingested).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.connector.lastSync).not.toBeNull();
    expect(result.connector.itemCount).toBe(5);
    const entries = memory.list().filter((entry) => entry.source === "connector");
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.trustTier).toBe("org_ratified");
      expect(entry.status).toBe("active");
      expect(entry.provenance.author).toBe(connector.id);
    }
  });

  it("re-sync is idempotent — no duplicates", () => {
    const { manager, memory } = harness();
    const connector = manager.add({ provider: "confluence", kind: "memory" });
    manager.connect(connector.id);
    expect(manager.sync(connector.id)!.ingested).toBe(3);
    const again = manager.sync(connector.id)!;
    expect(again.ingested).toBe(0);
    expect(again.skipped).toBe(3);
    expect(memory.list().filter((entry) => entry.source === "connector")).toHaveLength(3);
    expect(again.connector.itemCount).toBe(3);
  });

  it("synced entries are injectable (accepted tier) without any review", () => {
    const { manager, memory } = harness();
    const connector = manager.add({ provider: "databricks", kind: "memory" });
    manager.connect(connector.id);
    manager.sync(connector.id);
    const hits = memory.search("revenue_daily");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toBe("connector");
  });
});

describe("lifecycle", () => {
  it("connect/disconnect flips status and emits", () => {
    const { manager, emitted } = harness();
    const connector = manager.add({ provider: "teams" });
    expect(manager.connect(connector.id)!.status).toBe("connected");
    expect(manager.disconnect(connector.id)!.status).toBe("disconnected");
    const frames = emitted.filter((frame) => frame.kind === "org_connector");
    expect(frames.length).toBeGreaterThanOrEqual(3);
  });

  it("remove deletes the connector but keeps synced memory", () => {
    const { manager, memory } = harness();
    const connector = manager.add({ provider: "onedrive", kind: "memory" });
    manager.connect(connector.id);
    manager.sync(connector.id);
    expect(manager.remove(connector.id)).not.toBeNull();
    expect(manager.get(connector.id)).toBeNull();
    expect(memory.list().filter((entry) => entry.source === "connector")).toHaveLength(1);
  });
});
