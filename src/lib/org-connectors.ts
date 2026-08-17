// Client mirror of the server's org-connector records (server/org-connectors.ts).

import type { MemoryKind } from "@/lib/memory";

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

export interface OrgProviderInfo {
  provider: string;
  label: string;
  defaultTools: string[];
  sampleItems: Array<{ content: string; kind: MemoryKind }>;
}

export interface OrgConnectorInput {
  provider: string;
  kind?: OrgConnectorKind;
  accessLevel?: OrgAccessLevel;
}
