import type { AuditEntry, AuditManager } from "./audit.ts";
import type { CostEntry, CostManager, CostRollup } from "./costs.ts";
import type { Goal, GoalManager } from "./goals.ts";
import type { InboxItem, InboxManager, InboxQuestion } from "./inbox.ts";
import type { MemoryEntry, MemoryManager } from "./memory.ts";
import type { OrgConnector, OrgConnectorManager } from "./org-connectors.ts";
import type { OrgFileMeta, OrgFilesManager } from "./org-files.ts";
import type { OrgManager, OrgTeam, OrgUser } from "./org.ts";
import type { PipelineManager, PipelineRun, PipelineTemplate } from "./pipelines.ts";

// P11 export/import: the org's ported-feature data as one portable JSON
// bundle. WHAT IS IN IT: inbox, goals, pipelines, shared memory, org
// connectors, users/teams (no passwords), the cost ledger, plus two
// EXPORT-ONLY archival sections — the org-files index (metadata, no bytes;
// file content lives on disk and can be copied separately) and the audit
// chain (a hash chain is tamper-evidence of the EXPORTING instance; grafting
// it into another instance's chain would break both, so imports keep their
// own chain and record the import as a fresh audit entry).
// WHAT IS NEVER IN IT: password hashes, session tokens, API keys/config.json,
// bot transcripts (upstream's own data, out of scope for the org bundle).
// IMPORT SEMANTIC: empty-managers-only — the simpler honest semantic.
// Merge-by-id would silently have to pick winners for same-id records with
// different content; refusing unless the target sections are empty makes the
// result exactly the exported data, no guessing.

export const ORG_EXPORT_VERSION = 1;

export interface OrgExportBundle {
  version: number;
  exportedAt: number;
  inbox: { items: InboxItem[]; questions: InboxQuestion[] };
  goals: Goal[];
  pipelines: { templates: PipelineTemplate[]; runs: PipelineRun[] };
  memory: MemoryEntry[];
  orgConnectors: OrgConnector[];
  org: { users: Array<Omit<OrgUser, "password">>; teams: OrgTeam[] };
  costs: { entries: CostEntry[]; rollups: CostRollup[] };
  /** export-only: metadata index, no file bytes */
  orgFiles: OrgFileMeta[];
  /** export-only: the exporting instance's tamper-evident chain, newest first */
  audit: AuditEntry[];
}

export interface OrgExportDeps {
  inbox: InboxManager;
  goals: GoalManager;
  pipelines: PipelineManager;
  memory: MemoryManager;
  orgConnectors: OrgConnectorManager;
  org: OrgManager;
  costs: CostManager;
  orgFiles: OrgFilesManager;
  audit: AuditManager;
}

export function buildBundle(deps: OrgExportDeps, now: () => number = Date.now): OrgExportBundle {
  return {
    version: ORG_EXPORT_VERSION,
    exportedAt: now(),
    inbox: deps.inbox.exportState(),
    goals: deps.goals.exportState(),
    pipelines: deps.pipelines.exportState(),
    memory: deps.memory.exportState(),
    orgConnectors: deps.orgConnectors.exportState(),
    org: deps.org.exportState(),
    costs: deps.costs.exportState(),
    orgFiles: deps.orgFiles.list(),
    audit: deps.audit.list({ limit: Number.MAX_SAFE_INTEGER }),
  };
}

/** Counts per imported section, for the route response + audit detail. */
export interface OrgImportResult {
  imported: Record<string, number>;
}

const fail = (message: string) => {
  throw Object.assign(new Error(message), { status: 400 });
};

export function applyBundle(deps: OrgExportDeps, bundle: unknown): OrgImportResult {
  const b = bundle as Partial<OrgExportBundle> | null;
  if (!b || typeof b !== "object") fail("not an export bundle");
  if (b!.version !== ORG_EXPORT_VERSION) {
    fail(`bundle version ${String(b!.version)} does not match this app (expected ${ORG_EXPORT_VERSION})`);
  }
  // Empty-only, checked up front so a refusal changes nothing at all.
  const nonEmpty: string[] = [];
  const inbox = deps.inbox.exportState();
  if (inbox.items.length || inbox.questions.length) nonEmpty.push("inbox");
  if (deps.goals.exportState().length) nonEmpty.push("goals");
  const pipes = deps.pipelines.exportState();
  if (pipes.templates.length || pipes.runs.length) nonEmpty.push("pipelines");
  if (deps.memory.exportState().length) nonEmpty.push("memory");
  if (deps.orgConnectors.exportState().length) nonEmpty.push("org connectors");
  const org = deps.org.exportState();
  if (org.users.length || org.teams.length) nonEmpty.push("people & teams");
  const costs = deps.costs.exportState();
  if (costs.entries.length || costs.rollups.length) nonEmpty.push("costs");
  if (nonEmpty.length) {
    fail(`import needs an empty target — these already have data: ${nonEmpty.join(", ")}`);
  }

  deps.inbox.importState(b!.inbox ?? {});
  deps.goals.importState(b!.goals ?? []);
  deps.pipelines.importState(b!.pipelines ?? {});
  deps.memory.importState(b!.memory ?? []);
  deps.orgConnectors.importState(b!.orgConnectors ?? []);
  deps.org.importState(b!.org ?? {});
  deps.costs.importState(b!.costs ?? {});

  const after = {
    inbox: deps.inbox.exportState(),
    pipelines: deps.pipelines.exportState(),
    costs: deps.costs.exportState(),
  };
  return {
    imported: {
      inboxItems: after.inbox.items.length,
      inboxQuestions: after.inbox.questions.length,
      goals: deps.goals.exportState().length,
      templates: after.pipelines.templates.length,
      runs: after.pipelines.runs.length,
      memory: deps.memory.exportState().length,
      orgConnectors: deps.orgConnectors.exportState().length,
      users: deps.org.exportState().users.length,
      teams: deps.org.exportState().teams.length,
      costEntries: after.costs.entries.length,
      costRollups: after.costs.rollups.length,
    },
  };
}
