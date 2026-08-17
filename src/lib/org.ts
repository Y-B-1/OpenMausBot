// Client mirror of the server's org records (server/org.ts) + the session
// token. Org mode is OPT-IN: no token and orgMode off = today's solo app.

export type OrgRole = "admin" | "member";

export interface OrgUser {
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
  users: OrgUser[];
  teams: OrgTeam[];
}

const TOKEN_KEY = "omb-org-token";

export function orgToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setOrgToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}
