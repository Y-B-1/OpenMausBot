import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { MemoryViewer } from "./memory.ts";

// Org mode (P7): OPT-IN users/teams/roles with scrypt set-on-first-use
// passwords and persisted (restart-safe) session tokens, ported from
// platform/server/relay.ts. Off by default — solo/local use stays exactly
// as it is today, no login anywhere. Enabling turns on bearer-token auth
// for the API and team walls in shared memory.

export type OrgRole = "admin" | "member";

export interface OrgUser {
  id: string;
  name: string;
  role: OrgRole;
  teamIds: string[];
  /** scrypt record, set on first login with a password (relay semantics). */
  password?: { salt: string; hash: string };
  createdAt: number;
}

/** What clients see — never the password record. */
export interface PublicOrgUser {
  id: string;
  name: string;
  role: OrgRole;
  teamIds: string[];
  hasPassword: boolean;
  createdAt: number;
}

export interface OrgTeam {
  id: string;
  name: string;
  createdAt: number;
}

export interface OrgState {
  orgMode: boolean;
  users: PublicOrgUser[];
  teams: OrgTeam[];
}

interface OrgFile {
  version: 1;
  orgMode: boolean;
  users: OrgUser[];
  teams: OrgTeam[];
  /** token -> userId; persisted so sessions survive a restart. */
  sessions: Record<string, string>;
}

export interface OrgManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
}

const hashPassword = (password: string, salt: string): string =>
  scryptSync(password, salt, 32).toString("hex");

export class OrgManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: OrgManagerOptions;
  private orgMode = false;
  private users: OrgUser[] = [];
  private teams: OrgTeam[] = [];
  private sessions = new Map<string, string>(); // token -> userId

  constructor(options: OrgManagerOptions = {}) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "org.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<OrgFile>;
      this.orgMode = Boolean(disk.orgMode);
      this.users = Array.isArray(disk.users) ? disk.users : [];
      this.teams = Array.isArray(disk.teams) ? disk.teams : [];
      for (const [token, userId] of Object.entries(disk.sessions ?? {})) {
        if (typeof userId === "string") this.sessions.set(token, userId);
      }
    } catch {
      /* fresh install */
    }
  }

  /** Org mode on = auth required, team walls enforced. */
  get enabled(): boolean {
    return this.orgMode;
  }

  publicUser(user: OrgUser): PublicOrgUser {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      teamIds: [...user.teamIds],
      hasPassword: Boolean(user.password),
      createdAt: user.createdAt,
    };
  }

  state(): OrgState {
    return {
      orgMode: this.orgMode,
      users: this.users.map((u) => this.publicUser(u)),
      teams: this.teams.map((t) => ({ ...t })),
    };
  }

  setMode(enabled: boolean) {
    this.orgMode = Boolean(enabled);
    this.save();
    this.emitState();
  }

  /** The first user created becomes admin, whoever creates them. */
  createUser(name: string, role?: unknown): OrgUser {
    const trimmed = String(name ?? "").trim().slice(0, 80);
    if (!trimmed) throw new Error("A user needs a name");
    if (this.users.some((u) => u.name === trimmed)) throw new Error("That name is taken");
    const user: OrgUser = {
      id: randomUUID(),
      name: trimmed,
      role: this.users.length === 0 ? "admin" : role === "admin" ? "admin" : "member",
      teamIds: [],
      createdAt: this.now(),
    };
    this.users.push(user);
    this.save();
    this.emitState();
    return user;
  }

  /** Relay semantics: unknown name auto-creates a user (first = admin);
   * the first password provided sets it (scrypt); once set, logins require
   * it. Returns a persisted session token. */
  login(name: unknown, password: unknown): { token: string; user: PublicOrgUser } {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw Object.assign(new Error("name required"), { status: 400 });
    const pass = typeof password === "string" ? password : "";
    let user = this.users.find((u) => u.name === trimmed);
    if (user?.password) {
      const expected = Buffer.from(user.password.hash, "hex");
      const got = Buffer.from(hashPassword(pass, user.password.salt), "hex");
      if (!pass || expected.length !== got.length || !timingSafeEqual(expected, got)) {
        throw Object.assign(new Error("invalid password"), { status: 401 });
      }
    } else {
      if (!user) user = this.createUser(trimmed);
      if (pass) {
        const salt = randomBytes(16).toString("hex");
        user.password = { salt, hash: hashPassword(pass, salt) };
      }
    }
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, user.id);
    this.save();
    this.emitState();
    return { token, user: this.publicUser(user) };
  }

  logout(token: string) {
    if (this.sessions.delete(token)) this.save();
  }

  userForToken(token: string | null | undefined): OrgUser | null {
    if (!token) return null;
    const userId = this.sessions.get(token);
    return this.users.find((u) => u.id === userId) ?? null;
  }

  /** Token from the Authorization header, or ?token= (EventSource can't set
   * headers). */
  userForRequest(req: IncomingMessage, url: URL): OrgUser | null {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token");
    return this.userForToken(token);
  }

  setRole(id: string, role: unknown): OrgUser | null {
    const user = this.users.find((u) => u.id === id);
    if (!user) return null;
    user.role = role === "admin" ? "admin" : "member";
    this.save();
    this.emitState();
    return user;
  }

  setUserTeams(id: string, teamIds: unknown): OrgUser | null {
    const user = this.users.find((u) => u.id === id);
    if (!user) return null;
    const known = new Set(this.teams.map((t) => t.id));
    user.teamIds = (Array.isArray(teamIds) ? teamIds : []).filter(
      (t: unknown): t is string => typeof t === "string" && known.has(t),
    );
    this.save();
    this.emitState();
    return user;
  }

  createTeam(name: unknown): OrgTeam {
    const trimmed = String(name ?? "").trim().slice(0, 80);
    if (!trimmed) throw new Error("A team needs a name");
    const team: OrgTeam = { id: randomUUID(), name: trimmed, createdAt: this.now() };
    this.teams.push(team);
    this.save();
    this.emitState();
    return { ...team };
  }

  renameTeam(id: string, name: unknown): OrgTeam | null {
    const team = this.teams.find((t) => t.id === id);
    if (!team) return null;
    const trimmed = String(name ?? "").trim().slice(0, 80);
    if (trimmed) team.name = trimmed;
    this.save();
    this.emitState();
    return { ...team };
  }

  deleteTeam(id: string): boolean {
    const before = this.teams.length;
    this.teams = this.teams.filter((t) => t.id !== id);
    if (this.teams.length === before) return false;
    for (const user of this.users) user.teamIds = user.teamIds.filter((t) => t !== id);
    this.save();
    this.emitState();
    return true;
  }

  team(id: string): OrgTeam | null {
    const team = this.teams.find((t) => t.id === id);
    return team ? { ...team } : null;
  }

  /** The memory-wall viewer for an acting user. Null when org mode is off or
   * there is no user context (solo mode / background turns): all visible. */
  viewerFor(user: OrgUser | null): MemoryViewer | null {
    if (!this.orgMode || !user) return null;
    return { isAdmin: user.role === "admin", teamIds: [...user.teamIds] };
  }

  /** P11 export: users WITHOUT password records, and teams. Scrypt hashes
   * are offline-crackable secrets and the relay set-on-first-use semantics
   * make them unnecessary — an imported user simply sets a fresh password on
   * first login. Session tokens are never exported. */
  exportState(): { users: Array<Omit<OrgUser, "password">>; teams: OrgTeam[] } {
    return {
      users: this.users.map(({ password: _password, ...user }) => ({ ...user, teamIds: [...user.teamIds] })),
      teams: this.teams.map((t) => ({ ...t })),
    };
  }

  /** P11 import — only into an org with no users/teams yet. Does NOT touch
   * orgMode or sessions: the importing human flips org mode on deliberately. */
  importState(data: { users?: unknown; teams?: unknown }) {
    if (this.users.length || this.teams.length) throw new Error("org already has users or teams");
    this.teams = Array.isArray(data.teams) ? (data.teams as OrgTeam[]) : [];
    const known = new Set(this.teams.map((t) => t.id));
    this.users = (Array.isArray(data.users) ? (data.users as OrgUser[]) : []).map(
      ({ password: _password, ...user }) => ({ ...user, teamIds: (user.teamIds ?? []).filter((t) => known.has(t)) }),
    );
    this.save();
    this.emitState();
  }

  private emitState() {
    this.options.emit?.({ kind: "org", state: this.state() });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify(
        {
          version: 1,
          orgMode: this.orgMode,
          users: this.users,
          teams: this.teams,
          sessions: Object.fromEntries(this.sessions),
        } satisfies OrgFile,
        null,
        2,
      ),
    );
  }
}
