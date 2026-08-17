import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuditManager } from "./audit.ts";
import { CostManager } from "./costs.ts";
import { GoalManager } from "./goals.ts";
import { InboxManager } from "./inbox.ts";
import { MemoryManager } from "./memory.ts";
import { OrgConnectorManager } from "./org-connectors.ts";
import { OrgFilesManager } from "./org-files.ts";
import { OrgManager } from "./org.ts";
import { PipelineManager } from "./pipelines.ts";
import { applyBundle, buildBundle, ORG_EXPORT_VERSION, type OrgExportDeps } from "./org-export.ts";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-export-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A full manager set over its own temp dir — the shape the routes wire up. */
function harness(): OrgExportDeps & { dir: string } {
  const dir = tempDir();
  const memory = new MemoryManager({ file: join(dir, "memory.json") });
  const engineStubs = {
    botState: () => "ready" as const,
    createTask: () => ({ threadId: "t-1" }),
    startTurn: async () => {},
  };
  return {
    dir,
    inbox: new InboxManager({ file: join(dir, "inbox.json") }),
    goals: new GoalManager({ file: join(dir, "goals.json"), ...engineStubs }),
    pipelines: new PipelineManager({ file: join(dir, "pipelines.json"), ...engineStubs }),
    memory,
    orgConnectors: new OrgConnectorManager({ file: join(dir, "org-connectors.json"), memory }),
    org: new OrgManager({ file: join(dir, "org.json") }),
    costs: new CostManager({
      file: join(dir, "costs.json"),
      classify: () => "chat",
      botFor: () => null,
    }),
    orgFiles: new OrgFilesManager({ dir: join(dir, "org-files"), workspacesDir: join(dir, "workspaces") }),
    audit: new AuditManager({ file: join(dir, "audit.ndjson") }),
  };
}

function populate(h: OrgExportDeps) {
  h.inbox.postItem({ botId: "bot-1", text: "Weekly report drafted" });
  h.inbox.askQuestion({ botId: "bot-1", prompt: "Ship it?", options: ["yes", "no"] });
  h.goals.create({ botId: "bot-1", name: "Close the books", criteria: ["reconciled"] });
  h.pipelines.createTemplate({
    name: "Release",
    steps: [
      { title: "Build", prompt: "build it", botId: "bot-1" },
      { title: "Approve", prompt: "gate", botId: "bot-1", gate: "approval" },
    ],
  });
  h.memory.add({ kind: "fact", content: "The fiscal year ends in March", scope: "org", author: "you", sessionRef: "seed" });
  h.orgConnectors.add({ provider: "jira", kind: "agent" });
  const team = h.org.createTeam("Finance");
  const user = h.org.login("Sara", "hunter2-secret"); // sets a scrypt password
  h.org.setUserTeams(user.user.id, [team.id]);
  h.audit.record({ actor: "you", action: "goal.create", subject: "Close the books" });
}

describe("export bundle", () => {
  it("carries every section, versioned and timestamped", () => {
    const h = harness();
    populate(h);
    const bundle = buildBundle(h, () => 1234);
    expect(bundle.version).toBe(ORG_EXPORT_VERSION);
    expect(bundle.exportedAt).toBe(1234);
    expect(bundle.inbox.items).toHaveLength(1);
    expect(bundle.inbox.questions).toHaveLength(1);
    expect(bundle.goals).toHaveLength(1);
    expect(bundle.pipelines.templates).toHaveLength(1);
    expect(bundle.memory).toHaveLength(1);
    expect(bundle.orgConnectors).toHaveLength(1);
    expect(bundle.org.users.map((u) => u.name)).toEqual(["Sara"]);
    expect(bundle.org.teams.map((t) => t.name)).toEqual(["Finance"]);
    expect(bundle.audit.map((e) => e.action)).toContain("goal.create");
  });

  it("never contains secrets: no password hashes, no sessions, no api keys", () => {
    const h = harness();
    populate(h);
    const text = JSON.stringify(buildBundle(h));
    // the scrypt record and session-token map live in org.json but must
    // never reach the bundle; nor does config.json (API keys) at all
    expect(text).not.toMatch(/"password"|"salt"/);
    expect(text).not.toMatch(/"sessions":\{/);
    expect(text).not.toMatch(/apiKey|api_key/);
    expect(text).not.toContain("hunter2");
  });
});

describe("import", () => {
  it("round-trips: export → empty instance → import → data intact", () => {
    const source = harness();
    populate(source);
    const bundle = buildBundle(source);

    const target = harness();
    const result = applyBundle(target, bundle);
    expect(result.imported.memory).toBe(1);
    expect(result.imported.users).toBe(1);
    expect(target.inbox.listItems()[0].text).toBe("Weekly report drafted");
    expect(target.goals.list()[0].name).toBe("Close the books");
    expect(target.pipelines.listTemplates()[0].steps).toHaveLength(2);
    expect(target.memory.list()[0].content).toBe("The fiscal year ends in March");
    expect(target.orgConnectors.list()[0].provider).toBe("jira");
    const org = target.org.state();
    expect(org.users[0].name).toBe("Sara");
    expect(org.users[0].hasPassword).toBe(false); // set-on-first-use again
    expect(org.users[0].teamIds).toEqual([org.teams[0].id]);
    expect(org.orgMode).toBe(false); // never imported
    // a second export of the target matches the data sections of the source
    const again = buildBundle(target);
    expect(again.memory).toEqual(bundle.memory);
    // goals match except the deliberate running→paused defusal
    expect(again.goals).toEqual(
      bundle.goals.map((g) =>
        g.status === "running" ? { ...g, status: "paused", threadId: undefined } : g,
      ),
    );
  });

  it("refuses a version mismatch, changing nothing", () => {
    const target = harness();
    expect(() => applyBundle(target, { version: 99 })).toThrow(/version 99/);
    expect(target.memory.list()).toHaveLength(0);
  });

  it("refuses when any target section already has data, naming it", () => {
    const source = harness();
    populate(source);
    const bundle = buildBundle(source);
    const target = harness();
    target.memory.add({ kind: "fact", content: "already here", scope: "org", author: "you", sessionRef: "seed" });
    expect(() => applyBundle(target, bundle)).toThrow(/empty target.*memory/);
    // nothing else was touched by the refusal
    expect(target.inbox.listItems()).toHaveLength(0);
    expect(target.goals.list()).toHaveLength(0);
  });

  it("defuses in-flight state: running goals land paused, in-flight runs cancelled", () => {
    const source = harness();
    source.goals.create({ botId: "bot-1", name: "Running goal", criteria: ["done"] });
    expect(source.goals.list()[0].status).toBe("running");
    const bundle = buildBundle(source);
    // forge an in-flight pipeline run in the bundle (starting one for real
    // needs a live turn engine; the import contract is what's under test)
    bundle.pipelines.runs = [
      {
        id: "run-1",
        templateId: "tpl-1",
        name: "Release",
        botId: "bot-1",
        status: "waiting_approval",
        stepIndex: 1,
        steps: [
          { title: "Build", prompt: "build it", botId: "bot-1" },
          { title: "Approve", prompt: "gate", botId: "bot-1", gate: "approval" },
        ],
        stepStates: ["done", "pending"],
        stepOutputs: [],
        approvedSteps: [],
        createdAt: 1,
        updatedAt: 1,
      } as any,
    ];
    const target = harness();
    applyBundle(target, bundle);
    expect(target.goals.list()[0].status).toBe("paused");
    const run = target.pipelines.listRuns()[0];
    expect(run.status).toBe("cancelled");
    expect(run.haltReason).toMatch(/import/);
    // imported connectors always land disconnected
  });
});
