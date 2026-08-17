import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { MemoryKind, MemoryManager } from "./memory.ts";

// Org connectors (P6): a registry of organizational data/tool sources
// (SharePoint, Jira, GitHub, …) with mock sync into shared memory. Named
// "org connectors" because upstream already owns /api/connectors (Composio
// driver mounts) — this is a distinct feature. Real OAuth is deferred until
// credentials exist; mock sync keeps the memory-ingest path real end to end.
// Ported from platform/server/connectors.ts, RoutineManager/GoalManager
// module pattern (own JSON file, atomic writes, SSE emits).

export type OrgConnectorKind = "memory" | "agent";
export type OrgConnectorStatus = "connected" | "disconnected" | "error";
export type OrgAccessLevel = "read_only" | "write_no_delete";
export type OrgConnectorScope = "org" | "team" | "user";

export interface OrgConnectorTool {
  name: string;
  enabled: boolean;
}

export interface OrgConnector {
  id: string;
  provider: string;
  label: string;
  kind: OrgConnectorKind;
  status: OrgConnectorStatus;
  accessLevel: OrgAccessLevel;
  scope: OrgConnectorScope;
  tools: OrgConnectorTool[];
  lastSync: number | null;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A provider's mock corpus item: content plus the memory kind it lands as. */
export type SampleItem = { content: string; kind: MemoryKind };

export type ProviderInfo = {
  provider: string;
  label: string;
  defaultTools: string[];
  sampleItems: SampleItem[];
};

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    provider: "sharepoint",
    label: "SharePoint",
    defaultTools: ["search_documents", "read_document", "list_sites"],
    sampleItems: [
      { content: "Company handbook v4: remote-first, core hours 10:00-15:00 Dubai time.", kind: "procedure" },
      { content: "Q3 pricing sheet: Enterprise tier is $48/seat/month, billed annually.", kind: "fact" },
      { content: "Brand guidelines: primary color indigo, logotype set in a serif face.", kind: "preference" },
      { content: "ARR (annual recurring revenue): the yearly value of active subscriptions.", kind: "glossary" },
      { content: "2026-05 all-hands: leadership committed to the SSO launch for Q3.", kind: "episode" },
    ],
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    defaultTools: ["search_files", "read_file"],
    sampleItems: [{ content: "Sales playbook: discovery call script updated 2026-07.", kind: "procedure" }],
  },
  {
    provider: "teams",
    label: "Microsoft Teams",
    defaultTools: ["search_messages", "read_channel"],
    sampleItems: [{ content: "Ops standup decision: freeze deploys every Friday after 15:00.", kind: "preference" }],
  },
  {
    provider: "outlook",
    label: "Outlook",
    defaultTools: ["search_mail", "read_thread", "draft_reply"],
    sampleItems: [{ content: "Vendor contract renewal window opens 2026-09-01 (procurement thread).", kind: "fact" }],
  },
  {
    provider: "confluence",
    label: "Confluence",
    defaultTools: ["search_pages", "read_page"],
    sampleItems: [
      { content: "Engineering wiki: incident severity levels SEV1-SEV4 with paging rules.", kind: "procedure" },
      { content: "Architecture decision: event log is the source of truth; projections rebuild.", kind: "fact" },
      { content: "SEV1: a customer-facing outage with no workaround; pages the on-call immediately.", kind: "glossary" },
    ],
  },
  {
    provider: "jira",
    label: "Jira",
    defaultTools: ["search_issues", "read_issue", "create_issue", "comment"],
    sampleItems: [{ content: "Release train: fix versions cut every second Tuesday.", kind: "fact" }],
  },
  {
    provider: "databricks",
    label: "Databricks",
    defaultTools: ["run_query", "list_tables"],
    sampleItems: [{ content: "Gold table `revenue_daily` refreshes 06:00 UTC; SLA 07:00.", kind: "fact" }],
  },
  {
    provider: "github",
    label: "GitHub",
    defaultTools: ["search_code", "read_file", "open_pr", "comment"],
    sampleItems: [{ content: "Monorepo policy: squash merges only; conventional commit titles.", kind: "preference" }],
  },
];

export function providerInfo(provider: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find((p) => p.provider === provider);
}

const KINDS: OrgConnectorKind[] = ["memory", "agent"];
const SCOPES: OrgConnectorScope[] = ["org", "team", "user"];
const ACCESS_LEVELS: OrgAccessLevel[] = ["read_only", "write_no_delete"];

/** Owner's binding rule: memory connectors are strictly read-only; agent
 * connectors may write but never delete. Enforced server-side, always. */
export function constrainAccessLevel(kind: OrgConnectorKind, requested: unknown): OrgAccessLevel {
  if (kind === "memory") return "read_only";
  return ACCESS_LEVELS.includes(requested as OrgAccessLevel) ? (requested as OrgAccessLevel) : "read_only";
}

export interface OrgConnectorInput {
  provider: string;
  kind?: unknown;
  accessLevel?: unknown;
  scope?: unknown;
}

interface OrgConnectorFile {
  version: 1;
  connectors: OrgConnector[];
}

export interface OrgConnectorManagerOptions {
  memory: MemoryManager;
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
}

export class OrgConnectorManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: OrgConnectorManagerOptions;
  private connectors: OrgConnector[] = [];

  constructor(options: OrgConnectorManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "org-connectors.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<OrgConnectorFile>;
      this.connectors = Array.isArray(disk.connectors) ? disk.connectors : [];
    } catch {
      this.connectors = [];
    }
  }

  catalog(): ProviderInfo[] {
    return PROVIDER_CATALOG.map((p) => ({ ...p, sampleItems: p.sampleItems.map((s) => ({ ...s })) }));
  }

  list(): OrgConnector[] {
    return this.connectors.map((connector) => ({ ...connector, tools: connector.tools.map((t) => ({ ...t })) }));
  }

  get(id: string): OrgConnector | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    return connector ? { ...connector, tools: connector.tools.map((t) => ({ ...t })) } : null;
  }

  /** Add a connector from the catalog. Unknown providers are rejected;
   * access level is constrained by kind server-side. */
  add(input: OrgConnectorInput): OrgConnector {
    const info = providerInfo(String(input.provider ?? ""));
    if (!info) throw new Error(`Unknown provider: ${String(input.provider ?? "")}`);
    const kind = KINDS.includes(input.kind as OrgConnectorKind) ? (input.kind as OrgConnectorKind) : "memory";
    const at = this.now();
    const connector: OrgConnector = {
      id: randomUUID(),
      provider: info.provider,
      label: info.label,
      kind,
      status: "disconnected",
      accessLevel: constrainAccessLevel(kind, input.accessLevel),
      scope: SCOPES.includes(input.scope as OrgConnectorScope) ? (input.scope as OrgConnectorScope) : "org",
      tools: info.defaultTools.map((name) => ({ name, enabled: true })),
      lastSync: null,
      itemCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.connectors.unshift(connector);
    this.save();
    this.emitConnector(connector);
    return this.get(connector.id)!;
  }

  /** Reconfigure access level (still constrained by kind). */
  configure(id: string, patch: { accessLevel?: unknown }): OrgConnector | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return null;
    if (patch.accessLevel !== undefined) {
      connector.accessLevel = constrainAccessLevel(connector.kind, patch.accessLevel);
    }
    connector.updatedAt = this.now();
    this.save();
    this.emitConnector(connector);
    return this.get(id);
  }

  /** Mock connect: real OAuth is deferred until credentials exist. */
  connect(id: string): OrgConnector | null {
    return this.setStatus(id, "connected");
  }

  disconnect(id: string): OrgConnector | null {
    return this.setStatus(id, "disconnected");
  }

  setTool(id: string, name: string, enabled: boolean): OrgConnector | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return null;
    const tool = connector.tools.find((candidate) => candidate.name === name);
    if (!tool) return null;
    tool.enabled = Boolean(enabled);
    connector.updatedAt = this.now();
    this.save();
    this.emitConnector(connector);
    return this.get(id);
  }

  remove(id: string): OrgConnector | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return null;
    this.connectors = this.connectors.filter((candidate) => candidate.id !== id);
    this.save();
    this.options.emit?.({ kind: "org_connector_removed", id });
    return { ...connector, tools: connector.tools.map((t) => ({ ...t })) };
  }

  /** Mock sync: a memory-kind connected connector ingests its provider's
   * sample items into shared memory as org_ratified "connector" entries.
   * Idempotent — re-sync never duplicates (MemoryManager.ingestConnector). */
  sync(id: string): { connector: OrgConnector; ingested: number; skipped: number } | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector || connector.status !== "connected" || connector.kind !== "memory") return null;
    const info = providerInfo(connector.provider);
    const at = this.now();
    let ingested = 0;
    let skipped = 0;
    for (const item of info?.sampleItems ?? []) {
      const { created } = this.options.memory.ingestConnector({
        scope: connector.scope === "team" ? "space" : connector.scope === "user" ? "personal" : "org",
        kind: item.kind,
        content: item.content,
        author: connector.id,
        sessionRef: `sync-${at}`,
        source: "connector",
      });
      if (created) ingested += 1;
      else skipped += 1;
    }
    connector.lastSync = at;
    connector.itemCount = ingested + skipped;
    connector.updatedAt = at;
    this.save();
    this.emitConnector(connector);
    return { connector: this.get(id)!, ingested, skipped };
  }

  private setStatus(id: string, status: OrgConnectorStatus): OrgConnector | null {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return null;
    connector.status = status;
    connector.updatedAt = this.now();
    this.save();
    this.emitConnector(connector);
    return this.get(id);
  }

  private emitConnector(connector: OrgConnector) {
    this.options.emit?.({ kind: "org_connector", connector: { ...connector, tools: connector.tools.map((t) => ({ ...t })) } });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, connectors: this.connectors } satisfies OrgConnectorFile, null, 2),
    );
  }
}
