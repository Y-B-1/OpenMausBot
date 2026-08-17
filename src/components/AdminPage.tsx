import { useState } from "react";
import { LogOut, Plus, Shield, ShieldAlert, ShieldCheck, ScrollText, Trash2, User as UserIcon, Users } from "lucide-react";

import { cn } from "@/lib/cn";
import type { OrgTeam, OrgUser } from "@/lib/org";
import { useStore } from "@/state/store";

// Admin (P7): people & teams + the org-mode switch. Org mode is OPT-IN —
// off, the app is today's solo/local OpenMausBot with no login anywhere.
// MemoryPage/OrgConnectorsPage layout conventions, upstream tokens only.

function RoleBadge({ role }: { role: OrgUser["role"] }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        role === "admin" ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary",
      )}
    >
      {role === "admin" ? "Admin" : "Member"}
    </span>
  );
}

function OrgModeCard() {
  const { state, dispatch } = useStore();
  const on = Boolean(state.org?.orgMode);
  const isAdmin = !on || state.orgMe?.role === "admin";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="rounded-xl border border-hairline/50 bg-panel px-4 py-3.5">
      <div className="flex items-center gap-3">
        <ShieldCheck size={18} className={on ? "text-accent" : "text-ink-secondary"} />
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-ink">Org mode</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
            {on
              ? "On — everyone signs in with a name and password, and admins control which departments (teams) see which shared memory. Turning it off returns to the single-user app."
              : "Off — the app is single-user with no login, exactly as before. Turning it on adds sign-in, people & teams, and department walls around shared memory: a team-scoped entry is invisible to other departments."}
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-semibold",
            on ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
          )}
        >
          {on ? "ON" : "OFF"}
        </span>
      </div>
      {!on ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) dispatch({ type: "setOrgMode", enabled: true, name: name.trim(), password });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name (becomes the admin)"
            className="w-56 rounded-lg border border-hairline/60 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password (optional, sets on first use)"
            className="w-64 rounded-lg border border-hairline/60 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Turn on
          </button>
        </form>
      ) : (
        isAdmin && (
          <button
            onClick={() => dispatch({ type: "setOrgMode", enabled: false })}
            className="mt-3 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-danger transition-colors hover:bg-danger/10"
          >
            Turn off org mode
          </button>
        )
      )}
    </div>
  );
}

function UserRow({ user, teams, isAdmin }: { user: OrgUser; teams: OrgTeam[]; isAdmin: boolean }) {
  const { dispatch } = useStore();
  return (
    <div className="rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <UserIcon size={15} className="text-ink-secondary" />
        <span className="text-[13.5px] font-medium text-ink">{user.name}</span>
        <RoleBadge role={user.role} />
        {!user.hasPassword && <span className="text-[11px] text-ink-secondary/60">no password yet</span>}
        {isAdmin && (
          <button
            onClick={() =>
              dispatch({ type: "setOrgRole", userId: user.id, role: user.role === "admin" ? "member" : "admin" })
            }
            className="ml-auto rounded-lg px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            Make {user.role === "admin" ? "member" : "admin"}
          </button>
        )}
      </div>
      {teams.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {teams.map((team) => {
            const member = user.teamIds.includes(team.id);
            return (
              <button
                key={team.id}
                disabled={!isAdmin}
                onClick={() =>
                  dispatch({
                    type: "setOrgUserTeams",
                    userId: user.id,
                    teamIds: member ? user.teamIds.filter((t) => t !== team.id) : [...user.teamIds, team.id],
                  })
                }
                title={isAdmin ? (member ? `Remove from ${team.name}` : `Add to ${team.name}`) : undefined}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                  member ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary/70",
                  isAdmin && "hover:bg-accent/25",
                )}
              >
                {team.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AuditTab() {
  const { state } = useStore();
  const orgOn = Boolean(state.org?.orgMode);
  const isAdmin = !orgOn || state.orgMe?.role === "admin";
  const [filter, setFilter] = useState("");
  const verify = state.auditVerify;
  const groups = [...new Set(state.auditEntries.map((e) => e.action.split(".")[0]))].sort();
  const entries = filter
    ? state.auditEntries.filter((e) => e.action === filter || e.action.startsWith(filter + "."))
    : state.auditEntries;

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-dashed border-hairline/60 px-4 py-8 text-center text-[13px] text-ink-secondary">
        The audit log is admins-only while org mode is on.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* chain-verification badge: the whole point of the hash chain */}
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-4 py-3",
          verify?.valid
            ? "border-success/30 bg-success/10"
            : "border-danger/40 bg-danger/10",
        )}
      >
        {verify?.valid ? (
          <ShieldCheck size={17} className="text-success" />
        ) : (
          <ShieldAlert size={17} className="text-danger" />
        )}
        <div className="text-[13px] text-ink">
          {verify == null
            ? "Verifying the hash chain…"
            : verify.valid
              ? `Chain verified — ${verify.length} entries, each hash-linked to the one before. Tampering with any entry would break the chain here.`
              : `CHAIN BROKEN at entry ${verify.brokenAt?.index} (${verify.brokenAt?.reason}) — the log was altered after the fact.`}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setFilter("")}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11.5px] transition-colors",
            !filter ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary hover:text-ink",
          )}
        >
          All
        </button>
        {groups.map((group) => (
          <button
            key={group}
            onClick={() => setFilter(filter === group ? "" : group)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11.5px] transition-colors",
              filter === group ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary hover:text-ink",
            )}
          >
            {group}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2">
            <span className="w-40 shrink-0 truncate rounded-md bg-raised px-2 py-0.5 text-[11.5px] font-medium text-ink">
              {entry.action}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
              {entry.subject}
              {entry.detail && <span className="text-ink-secondary"> — {entry.detail}</span>}
            </span>
            <span className="shrink-0 text-[11.5px] text-ink-secondary">{entry.actor}</span>
            <span
              className="shrink-0 font-mono text-[10.5px] text-ink-secondary/60"
              title={`hash ${entry.hash}
prev ${entry.prevHash}`}
            >
              {entry.hash.slice(0, 8)}
            </span>
            <span className="w-24 shrink-0 text-right text-[11.5px] tabular-nums text-ink-secondary">
              {new Date(entry.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
        {entries.length === 0 && (
          <div className="rounded-xl border border-dashed border-hairline/60 px-4 py-8 text-center text-[13px] text-ink-secondary">
            Nothing recorded yet. Consequential actions — goals, gates, connectors, memory review, files — land here as a tamper-evident chain.
          </div>
        )}
      </div>
    </div>
  );
}

export function AdminPage() {
  const { state, dispatch } = useStore();
  const org = state.org;
  const orgOn = Boolean(org?.orgMode);
  const isAdmin = !orgOn || state.orgMe?.role === "admin";
  const [newUser, setNewUser] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [tab, setTab] = useState<"people" | "audit">("people");

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="text-[17px] font-semibold text-ink">Admin</div>
              {orgOn && state.orgMe && (
                <button
                  onClick={() => dispatch({ type: "logoutOrg" })}
                  className="ml-auto flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised/70"
                >
                  <LogOut size={13} />
                  Sign out {state.orgMe.name}
                </button>
              )}
            </div>
            <div className="mt-1 text-[12.5px] text-ink-secondary">
              People, teams, the org-mode switch and the audit log.
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {(
              [
                { id: "people", label: "People & Teams", Icon: Users },
                { id: "audit", label: "Audit log", Icon: ScrollText },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors",
                  tab === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {tab === "audit" ? (
            <AuditTab />
          ) : (
            <>
          <OrgModeCard />

          {/* People & Teams */}
          <section>
            <div className="flex items-center gap-2">
              <Users size={15} className="text-ink-secondary" />
              <div className="text-[14px] font-semibold text-ink">People</div>
              <div className="text-[12px] text-ink-secondary">— the first person becomes the admin</div>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {(org?.users ?? []).map((user) => (
                <UserRow key={user.id} user={user} teams={org?.teams ?? []} isAdmin={isAdmin} />
              ))}
              {(org?.users ?? []).length === 0 && (
                <div className="rounded-xl border border-dashed border-hairline/60 px-4 py-6 text-center text-[13px] text-ink-secondary">
                  No people yet. Turn on org mode, or add someone below.
                </div>
              )}
              {isAdmin && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newUser.trim()) {
                      dispatch({ type: "addOrgUser", name: newUser.trim() });
                      setNewUser("");
                    }
                  }}
                >
                  <input
                    value={newUser}
                    onChange={(e) => setNewUser(e.target.value)}
                    placeholder="Add a person by name"
                    className="w-64 rounded-lg border border-hairline/60 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
                  />
                  <button
                    type="submit"
                    disabled={!newUser.trim()}
                    className="flex items-center gap-1 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink disabled:opacity-50"
                  >
                    <Plus size={13} />
                    Add
                  </button>
                </form>
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2">
              <Shield size={15} className="text-ink-secondary" />
              <div className="text-[14px] font-semibold text-ink">Teams</div>
              <div className="text-[12px] text-ink-secondary">
                — departments; team-scoped memory is walled off from the others
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {(org?.teams ?? []).map((team) => {
                const members = (org?.users ?? []).filter((u) => u.teamIds.includes(team.id));
                return (
                  <div key={team.id} className="flex items-center gap-2.5 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2.5">
                    <span className="text-[13.5px] font-medium text-ink">{team.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {members.map((m) => (
                        <span key={m.id} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">
                          {m.name}
                        </span>
                      ))}
                      {members.length === 0 && (
                        <span className="text-[11px] text-ink-secondary/60">no members yet</span>
                      )}
                    </span>
                    {isAdmin && (
                      <button
                        onClick={() => dispatch({ type: "removeOrgTeam", teamId: team.id })}
                        title="Delete team"
                        className="ml-auto rounded-lg p-1 text-ink-secondary/70 transition-colors hover:bg-raised hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
              {isAdmin && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newTeam.trim()) {
                      dispatch({ type: "addOrgTeam", name: newTeam.trim() });
                      setNewTeam("");
                    }
                  }}
                >
                  <input
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    placeholder="Add a team (e.g. Finance)"
                    className="w-64 rounded-lg border border-hairline/60 bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
                  />
                  <button
                    type="submit"
                    disabled={!newTeam.trim()}
                    className="flex items-center gap-1 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink disabled:opacity-50"
                  >
                    <Plus size={13} />
                    Add
                  </button>
                </form>
              )}
            </div>
          </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
