import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { InboxPage } from "@/components/InboxPage";
import { GoalsPage } from "@/components/GoalsPage";
import { BoardPage } from "@/components/BoardPage";
import { PipelinesPage } from "@/components/PipelinesPage";
import { MemoryPage } from "@/components/MemoryPage";
import { OrgConnectorsPage } from "@/components/OrgConnectorsPage";
import { AdminPage } from "@/components/AdminPage";
import { LoginGate } from "@/components/LoginGate";
import { orgToken } from "@/lib/org";
import { NoEngines } from "@/components/NoEngines";

function Shell() {
  const { state, dispatch } = useStore();
  // P7 org mode: with auth on and no session, everything waits behind the
  // login gate. Solo mode (org.orgMode false / unknown) never sees it.
  // (Checked after the hooks below — hooks must run unconditionally.)
  const needsLogin = Boolean(state.org?.orgMode) && !state.orgMe && !orgToken();
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  // Nothing on this machine can run a bot. Wait for the first /api/instances
  // response before deciding — an empty list means "not asked yet", and
  // flashing the setup screen at every launch would be worse than the bug.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some(
      (i) => i.snapshot.state === "available" && i.snapshot.authenticated !== false,
    );

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  if (needsLogin) return <LoginGate />;

  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      {state.activeView === "routines" ? (
        <RoutinesPage />
      ) : state.activeView === "inbox" ? (
        <InboxPage />
      ) : state.activeView === "goals" ? (
        <GoalsPage />
      ) : state.activeView === "board" ? (
        <BoardPage />
      ) : state.activeView === "pipelines" ? (
        <PipelinesPage />
      ) : state.activeView === "memory" ? (
        <MemoryPage />
      ) : state.activeView === "connectors" ? (
        <OrgConnectorsPage />
      ) : state.activeView === "admin" ? (
        <AdminPage />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
