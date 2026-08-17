import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OrgManager } from "./org.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-org-"));
  dirs.push(dir);
  return join(dir, "org.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("org mode toggle", () => {
  it("is off by default — solo mode, no auth", () => {
    const org = new OrgManager({ file: tempFile() });
    expect(org.enabled).toBe(false);
    expect(org.viewerFor(null)).toBeNull();
  });

  it("toggle persists across restarts", () => {
    const file = tempFile();
    new OrgManager({ file }).setMode(true);
    expect(new OrgManager({ file }).enabled).toBe(true);
  });
});

describe("users and roles", () => {
  it("the first user created becomes admin, later ones members", () => {
    const org = new OrgManager({ file: tempFile() });
    expect(org.createUser("Yosri").role).toBe("admin");
    expect(org.createUser("Sara").role).toBe("member");
  });

  it("the first user to log in becomes admin", () => {
    const org = new OrgManager({ file: tempFile() });
    expect(org.login("Yosri", "hunter2").user.role).toBe("admin");
    expect(org.login("Sara", "pw").user.role).toBe("member");
  });

  it("role changes and duplicate names are handled", () => {
    const org = new OrgManager({ file: tempFile() });
    const a = org.createUser("Yosri");
    const b = org.createUser("Sara");
    expect(org.setRole(b.id, "admin")?.role).toBe("admin");
    expect(org.setRole(a.id, "member")?.role).toBe("member");
    expect(() => org.createUser("Sara")).toThrow(/taken/);
  });
});

describe("set-on-first-use passwords (scrypt)", () => {
  it("first login with a password sets it; the wrong password then fails", () => {
    const org = new OrgManager({ file: tempFile() });
    org.login("Yosri", "hunter2");
    expect(() => org.login("Yosri", "wrong")).toThrow(/invalid password/);
    expect(() => org.login("Yosri", "")).toThrow(/invalid password/);
    expect(org.login("Yosri", "hunter2").user.name).toBe("Yosri");
  });

  it("password hashes persist across restarts and are never exposed", () => {
    const file = tempFile();
    new OrgManager({ file }).login("Yosri", "hunter2");
    const org = new OrgManager({ file });
    expect(() => org.login("Yosri", "wrong")).toThrow(/invalid password/);
    const { user } = org.login("Yosri", "hunter2");
    expect(user.hasPassword).toBe(true);
    expect((user as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("sessions", () => {
  it("login returns a token that resolves to the user; logout kills it", () => {
    const org = new OrgManager({ file: tempFile() });
    const { token, user } = org.login("Yosri", "pw");
    expect(org.userForToken(token)?.id).toBe(user.id);
    org.logout(token);
    expect(org.userForToken(token)).toBeNull();
  });

  it("sessions survive a restart (persisted)", () => {
    const file = tempFile();
    const { token } = new OrgManager({ file }).login("Yosri", "pw");
    expect(new OrgManager({ file }).userForToken(token)?.name).toBe("Yosri");
  });
});

describe("teams", () => {
  it("CRUD-lite: create, rename, delete; delete removes memberships", () => {
    const org = new OrgManager({ file: tempFile() });
    const user = org.createUser("Yosri");
    const team = org.createTeam("Finance");
    org.setUserTeams(user.id, [team.id, "bogus-team"]);
    expect(org.userForToken(org.login("Yosri", "").token)?.teamIds).toEqual([team.id]);
    expect(org.renameTeam(team.id, "Treasury")?.name).toBe("Treasury");
    expect(org.deleteTeam(team.id)).toBe(true);
    expect(org.state().teams).toHaveLength(0);
    expect(org.state().users[0]!.teamIds).toEqual([]);
  });
});

describe("memory viewer", () => {
  it("org mode off or no user -> null viewer (all visible)", () => {
    const org = new OrgManager({ file: tempFile() });
    const user = org.createUser("Yosri");
    expect(org.viewerFor(user)).toBeNull(); // mode off
    org.setMode(true);
    expect(org.viewerFor(null)).toBeNull(); // no user context
  });

  it("org mode on: admins see everything, members carry their team ids", () => {
    const org = new OrgManager({ file: tempFile() });
    org.setMode(true);
    const admin = org.createUser("Yosri");
    const member = org.createUser("Sara");
    const team = org.createTeam("Finance");
    org.setUserTeams(member.id, [team.id]);
    expect(org.viewerFor(admin)).toEqual({ isAdmin: true, teamIds: [] });
    expect(org.viewerFor(org.userForToken(org.login("Sara", "").token))).toEqual({
      isAdmin: false,
      teamIds: [team.id],
    });
  });
});
