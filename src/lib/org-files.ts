// Client mirror of the server's org files records (server/org-files.ts).

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

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
