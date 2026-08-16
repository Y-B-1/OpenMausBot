// W7 (E2): connector catalog + mock sync provider. Real providers (M365
// Graph, Atlassian, Databricks) plug in behind syncItems() once OAuth app
// credentials exist; until then the mock returns plausible, deterministic
// items so the memory-ingest path is real end to end.
import crypto from "node:crypto";
import type { ConnectorRecord, ConnectorTool, MemoryEntry, MemoryKind } from "../shared/contracts.ts";

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

export function defaultTools(provider: string): ConnectorTool[] {
  return (providerInfo(provider)?.defaultTools ?? ["search", "read"]).map((name) => ({ name, enabled: true }));
}

/** Mock ingest: turn the provider's sample items into org-ratified memory entries. */
export function syncItems(connector: ConnectorRecord): MemoryEntry[] {
  const info = providerInfo(connector.provider);
  const items = info?.sampleItems ?? [];
  const now = Date.now();
  return items.map((item) => {
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      scope: connector.scope === "team" ? "space" : connector.scope === "user" ? "personal" : "org",
      kind: item.kind,
      content: item.content,
      provenance: { author: connector.id, sessionRef: `sync-${now}` },
      // Systems of record are trusted as-is: no human review queue for
      // connector-synced entries (review is for what AGENTS claim to know).
      trustTier: "org_ratified",
      status: "active",
      ts: now,
      source: "connector",
    };
    if (connector.teamId !== undefined) entry.teamId = connector.teamId;
    return entry;
  });
}
