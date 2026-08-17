import { useRef } from "react";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  FolderOpen,
  Trash2,
  Upload,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { formatBytes, type OrgFileMeta } from "@/lib/org-files";
import { orgToken } from "@/lib/org";
import { useStore } from "@/state/store";

// Files (P9): artifacts humans share or agents produce. Uploads are soft-
// deleted (retire) and driver workspace outputs appear read-only.

function iconFor(file: OrgFileMeta) {
  const name = file.name.toLowerCase();
  if (file.mime.startsWith("image/")) return FileImage;
  if (/\.(ts|tsx|js|jsx|py|rs|go|json|sh)$/.test(name)) return FileCode;
  if (/\.(zip|tar|gz|7z)$/.test(name)) return FileArchive;
  if (file.mime.startsWith("text/") || /\.(md|txt|csv)$/.test(name)) return FileText;
  return FileIcon;
}

function FileRow({ file }: { file: OrgFileMeta }) {
  const { dispatch } = useStore();
  const Icon = iconFor(file);
  const token = orgToken();
  const href = `/api/org-files/${encodeURIComponent(file.id)}/download${token ? `?token=${token}` : ""}`;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5",
        file.retired && "opacity-50",
      )}
    >
      <Icon size={17} className="shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{file.name}</span>
          {file.source === "workspace" && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">workspace</span>
          )}
          {file.retired && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-[10.5px] text-ink-secondary">retired</span>
          )}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-secondary">
          {formatBytes(file.size)} · {file.uploader} ·{" "}
          {new Date(file.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <a
        href={href}
        download={file.name}
        title="Download"
        className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
      >
        <Download size={15} />
      </a>
      {file.source === "upload" && !file.retired && (
        <button
          onClick={() => dispatch({ type: "retireOrgFile", fileId: file.id })}
          title="Retire (soft delete — the file stays recoverable on disk)"
          className="rounded-lg p-1.5 text-ink-secondary/70 transition-colors hover:bg-raised hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

export function FilesPage() {
  const { state, dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const uploads = state.orgFiles.filter((f) => f.source === "upload");
  const workspace = state.orgFiles.filter((f) => f.source === "workspace");

  const onPick = (picked: FileList | null) => {
    const file = picked?.[0];
    if (!file) return;
    if (file.size > 700_000) {
      dispatch({ type: "error", message: "Files are capped at 700KB for now." });
      setTimeout(() => dispatch({ type: "error", message: null }), 6000);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataBase64 = String(reader.result ?? "").split(",")[1] ?? "";
      dispatch({
        type: "uploadOrgFile",
        input: {
          name: file.name,
          dataBase64,
          mime: file.type || "application/octet-stream",
          uploader: state.orgMe?.name,
        },
      });
    };
    reader.readAsDataURL(file);
    if (input.current) input.current.value = "";
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-6">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-[17px] font-semibold text-ink">Files</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">
                Artifacts your agents produced or people shared. Deleting retires — nothing is destroyed.
              </div>
            </div>
            <button
              onClick={() => input.current?.click()}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <Upload size={14} />
              Upload
            </button>
            <input ref={input} type="file" className="hidden" onChange={(e) => onPick(e.target.files)} />
          </div>

          <section className="flex flex-col gap-2">
            {uploads.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
            {uploads.length === 0 && (
              <div className="rounded-xl border border-dashed border-hairline/60 px-4 py-8 text-center text-[13px] text-ink-secondary">
                No shared files yet. Upload one, or let an agent produce something.
              </div>
            )}
          </section>

          {workspace.length > 0 && (
            <section>
              <div className="flex items-center gap-2">
                <FolderOpen size={15} className="text-ink-secondary" />
                <div className="text-[14px] font-semibold text-ink">Agent workspaces</div>
                <div className="text-[12px] text-ink-secondary">— read-only, straight from the bots' working dirs</div>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {workspace.map((file) => (
                  <FileRow key={file.id} file={file} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
