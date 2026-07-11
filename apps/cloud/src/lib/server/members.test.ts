/**
 * Member management (Wave M): role changes and removal against a fake
 * MembersDb, with the LAST-OWNER invariant as the load-bearing case — a vault
 * must always keep at least one owner, so the last owner can never be
 * demoted, removed, or allowed to leave.
 */
import { describe, expect, it } from "vitest";
import {
  changeMemberRole,
  LAST_OWNER_MESSAGE,
  removeMember,
  type MemberRecord,
  type MembersDb,
} from "./members";

const NOW = new Date("2026-07-10T00:00:00.000Z");

function member(userId: string, role: MemberRecord["role"]): MemberRecord {
  return { userId, email: `${userId}@example.com`, name: userId, role, createdAt: NOW };
}

function fakeDb(initial: MemberRecord[]) {
  const members = new Map(initial.map((m) => [m.userId, { ...m }]));
  const db: MembersDb = {
    listMembers: async () => [...members.values()],
    getMember: async (_vaultId, userId) => members.get(userId) ?? null,
    countOwners: async () => [...members.values()].filter((m) => m.role === "owner").length,
    updateRole: async (_vaultId, userId, role) => {
      const m = members.get(userId);
      if (m) members.set(userId, { ...m, role });
    },
    deleteMember: async (_vaultId, userId) => {
      members.delete(userId);
    },
  };
  return { db, members };
}

const VAULT = "vault-1";

describe("changeMemberRole", () => {
  it("promotes and demotes ordinary members", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "viewer")]);
    const result = await changeMemberRole(db, { vaultId: VAULT, targetUserId: "bob", role: "editor" });
    expect(result).toMatchObject({ ok: true, member: { userId: "bob", role: "editor" } });
    expect(members.get("bob")!.role).toBe("editor");
  });

  it("unknown member → 404", async () => {
    const { db } = fakeDb([member("alice", "owner")]);
    const result = await changeMemberRole(db, { vaultId: VAULT, targetUserId: "ghost", role: "viewer" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("demoting the LAST owner is refused (409)", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "editor")]);
    const result = await changeMemberRole(db, { vaultId: VAULT, targetUserId: "alice", role: "editor" });
    expect(result).toEqual({ ok: false, status: 409, message: LAST_OWNER_MESSAGE });
    expect(members.get("alice")!.role).toBe("owner"); // untouched
  });

  it("demoting an owner is fine when ANOTHER owner remains", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "owner")]);
    const result = await changeMemberRole(db, { vaultId: VAULT, targetUserId: "alice", role: "viewer" });
    expect(result).toMatchObject({ ok: true });
    expect(members.get("alice")!.role).toBe("viewer");
    expect(members.get("bob")!.role).toBe("owner");
  });

  it("a no-op role change succeeds without touching the last-owner guard", async () => {
    const { db } = fakeDb([member("alice", "owner")]);
    const result = await changeMemberRole(db, { vaultId: VAULT, targetUserId: "alice", role: "owner" });
    expect(result).toMatchObject({ ok: true, member: { role: "owner" } });
  });
});

describe("removeMember", () => {
  it("an owner removes another member", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "editor")]);
    const result = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "bob",
      callerUserId: "alice",
      callerRole: "owner",
    });
    expect(result).toEqual({ ok: true });
    expect(members.has("bob")).toBe(false);
  });

  it("a non-owner may remove THEMSELVES (self-leave)…", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "viewer")]);
    const result = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "bob",
      callerUserId: "bob",
      callerRole: "viewer",
    });
    expect(result).toEqual({ ok: true });
    expect(members.has("bob")).toBe(false);
  });

  it("…but never anyone else (403)", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "editor"), member("eve", "editor")]);
    const result = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "bob",
      callerUserId: "eve",
      callerRole: "editor",
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(members.has("bob")).toBe(true);
  });

  it("removing the LAST owner is refused (409) — including their own self-leave", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "editor")]);
    const removed = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "alice",
      callerUserId: "alice",
      callerRole: "owner",
    });
    expect(removed).toEqual({ ok: false, status: 409, message: LAST_OWNER_MESSAGE });
    expect(members.has("alice")).toBe(true);
  });

  it("an owner may leave when another owner remains", async () => {
    const { db, members } = fakeDb([member("alice", "owner"), member("bob", "owner")]);
    const result = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "alice",
      callerUserId: "alice",
      callerRole: "owner",
    });
    expect(result).toEqual({ ok: true });
    expect(members.has("alice")).toBe(false);
  });

  it("unknown member → 404", async () => {
    const { db } = fakeDb([member("alice", "owner")]);
    const result = await removeMember(db, {
      vaultId: VAULT,
      targetUserId: "ghost",
      callerUserId: "alice",
      callerRole: "owner",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
