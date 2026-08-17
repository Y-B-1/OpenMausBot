import { useMemo, useState } from "react";
import { Brain, Cable, Plug, Plus, RefreshCw, Trash2, Wrench } from "lucide-react";

import { cn } from "@/lib/cn";
import type { OrgConnector, OrgConnectorKind, OrgConnectorStatus } from "@/lib/org-connectors";
import { useStore } from "@/state/store";

// Org connectors: registry of organizational sources (SharePoint, Jira, …)
// with mock sync into shared memory. Distinct from the Composio connectors
// under Plugins. MemoryPage layout conventions, upstream tokens only.

const STATUS_META: Record<OrgConnectorStatus, { label: string; className: string }> = {
  connected: { label: "Connected", className: "bg-success/15 text-success" },
  disconnected: { label: "Disconnected", className: "bg-raised text-ink-secondary" },
  error: { label: "Error", className: "bg-danger/15 text-danger" },
};

const KIND_META: Record<OrgConnectorKind, { label: string; blurb: string; Icon: typeof Brain }> = {
  memory: { label: "Memory", blurb: "syncs knowledge into shared memory — strictly read-only", Icon: Brain },
  agent: { label: "Agent tools", blurb: "tools bots may call — may write, never delete", Icon: Wrench },
};

function niceWhen(at: number) {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatusPill({ status }: { status: OrgConnectorStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className)}>{meta.label}</span>
  );
}

function AddFromCatalog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [kind, setKind] = useState<OrgConnectorKind>("memory");
  return (
    <div className="mt-3 rounded-xl border border-hairline/50 bg-panel p-3.5">
      <div className="flex items-center gap-1">
        {(Object.keys(KIND_META) as OrgConnectorKind[]).map((value) => (
          <button
            key={value}
            onClick={() => setKind(value)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[12px] transition-colors",
              kind === value ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50",
            )}
          >
            {KIND_META[value].label}
          </button>
        ))}
        <span className="ml-2 text-[11.5px] text-ink-secondary/70">{KIND_META[kind].blurb}</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {state.orgConnectorCatalog.map((info) => (
          <button
            key={info.provider}
            onClick={() => {
              dispatch({
                type: "addOrgConnector",
                input: {
                  provider: info.provider,
                  kind,
                  accessLevel: kind === "agent" ? "write_no_delete" : "read_only",
                },
              });
              onClose();
            }}
            className="flex flex-col items-start gap-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-raised/40"
          >
            <span className="text-[13px] font-medium text-ink">{info.label}</span>
            <span className="text-[11px] text-ink-secondary">{info.defaultTools.length} tools</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectorDetail({ connector }: { connector: OrgConnector }) {
  const { state, dispatch } = useStore();
  const kindMeta = KIND_META[connector.kind];
  const synced = useMemo(
    () =>
      state.memoryEntries.filter(
        (entry) => entry.source === "connector" && entry.provenance.author === connector.id && entry.status === "active",
      ).length,
    [state.memoryEntries, connector.id],
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-6">
      <div className="flex items-center gap-3">
        <div className="text-[16px] font-semibold text-ink">{connector.label}</div>
        <StatusPill status={connector.status} />
        <span className="ml-auto flex items-center gap-1.5">
          {connector.status === "connected" ? (
            <>
              {connector.kind === "memory" && (
                <button
                  onClick={() => dispatch({ type: "syncOrgConnector", connectorId: connector.id })}
                  className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white"
                >
                  <RefreshCw size={13} />
                  Sync now
                </button>
              )}
              <button
                onClick={() => dispatch({ type: "disconnectOrgConnector", connectorId: connector.id })}
                className="rounded-lg border border-hairline/60 bg-inset px-2.5 py-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-raised"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => dispatch({ type: "connectOrgConnector", connectorId: connector.id })}
              className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white"
            >
              <Plug size={13} />
              Connect
            </button>
          )}
          <button
            onClick={() => dispatch({ type: "removeOrgConnector", connectorId: connector.id })}
            title="Remove connector (synced memory stays)"
            className="rounded-lg p-1.5 text-ink-secondary/70 transition-colors hover:bg-raised hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-secondary">
        <kindMeta.Icon size={13} />
        {kindMeta.label} connector — {kindMeta.blurb}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-hairline/50 bg-panel px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">
            {connector.accessLevel === "read_only" ? "Read-only" : "Write, no delete"}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">Access level (enforced by the server)</div>
        </div>
        <div className="rounded-xl border border-hairline/50 bg-panel px-3 py-2.5">
          <div className="text-[13px] font-medium tabular-nums text-ink">
            {connector.lastSync ? niceWhen(connector.lastSync) : "Never"}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">Last sync</div>
        </div>
        <div className="rounded-xl border border-hairline/50 bg-panel px-3 py-2.5">
          <div className="text-[13px] font-medium tabular-nums text-ink">{synced || connector.itemCount}</div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">Items in shared memory</div>
        </div>
      </div>

      <div className="mt-6 text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Tools</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {connector.tools.map((tool) => (
          <label
            key={tool.name}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5"
          >
            <span className={cn("flex-1 font-mono text-[12.5px]", tool.enabled ? "text-ink" : "text-ink-secondary/60")}>
              {tool.name}
            </span>
            <button
              role="switch"
              aria-checked={tool.enabled}
              onClick={() =>
                dispatch({
                  type: "toggleOrgConnectorTool",
                  connectorId: connector.id,
                  name: tool.name,
                  enabled: !tool.enabled,
                })
              }
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                tool.enabled ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-all",
                  tool.enabled ? "left-[18px]" : "left-0.5",
                )}
              />
            </button>
          </label>
        ))}
      </div>
      {connector.kind === "memory" && (
        <div className="mt-4 text-[11.5px] text-ink-secondary/70">
          Synced knowledge lands in shared Memory as ratified, connector-sourced entries. Systems of record are
          trusted as-is; the review queue is for what bots claim to know.
        </div>
      )}
    </div>
  );
}

export function OrgConnectorsPage() {
  const { state } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const connectors = state.orgConnectors;
  const selected = connectors.find((connector) => connector.id === selectedId) ?? connectors[0] ?? null;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex min-h-0 flex-1">
        {/* list pane */}
        <div className="flex w-[340px] shrink-0 flex-col border-r border-hairline/50">
          <div className="px-5 pt-6">
            <div className="flex items-center gap-3">
              <div className="text-[17px] font-semibold text-ink">Connectors</div>
              <button
                onClick={() => setAdding((v) => !v)}
                className="ml-auto flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised/70"
              >
                <Plus size={13} />
                Add
              </button>
            </div>
            <div className="mt-1 text-[12.5px] text-ink-secondary">
              Organizational sources: knowledge synced into memory, tools for bots.
            </div>
            {adding && <AddFromCatalog onClose={() => setAdding(false)} />}
          </div>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {connectors.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-ink-secondary">
                <Cable size={22} />
                <div className="text-[13.5px]">No connectors yet. Add one from the catalog.</div>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {connectors.map((connector) => {
                  const Icon = KIND_META[connector.kind].Icon;
                  return (
                    <button
                      key={connector.id}
                      onClick={() => setSelectedId(connector.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                        selected?.id === connector.id ? "bg-raised" : "hover:bg-raised/50",
                      )}
                    >
                      <Icon size={16} className="shrink-0 text-ink-secondary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-ink">{connector.label}</span>
                        <span className="block text-[11px] text-ink-secondary">
                          {KIND_META[connector.kind].label}
                          {connector.lastSync ? ` · synced ${niceWhen(connector.lastSync)}` : ""}
                        </span>
                      </span>
                      <StatusPill status={connector.status} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {/* detail pane */}
        {selected ? (
          <ConnectorDetail key={selected.id} connector={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13.5px] text-ink-secondary">
            Select a connector
          </div>
        )}
      </div>
    </main>
  );
}
