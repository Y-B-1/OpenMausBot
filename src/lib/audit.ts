// Client mirror of the server's audit log records (server/audit.ts).

export interface AuditEntry {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  detail?: string;
  prevHash: string;
  hash: string;
}

export interface AuditVerifyResult {
  valid: boolean;
  length: number;
  brokenAt?: { index: number; id: string; reason: "hash" | "link" };
}
