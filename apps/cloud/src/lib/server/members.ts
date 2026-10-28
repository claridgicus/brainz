/**
 * Vault member management (Wave M): list, change role, remove/leave — with
 * the LAST-OWNER invariant enforced in one place: a vault must always have at
 * least one owner, so the last owner can never be demoted, removed, or leave.
 *
 * Ports-and-fakes like $lib/server/claim: the decision logic runs against the
 * small `MembersDb` port so it is unit-testable without a Workers/D1 runtime;
 * `membersDbFrom` wires it to drizzle/D1.
 *
 * Authorization is the CALLER's job (routes gate via requireVaultAccess):
 * - change role: owner-only.
 * - remove: owner may remove anyone; any member may remove THEMSELVES
 *   (self-leave). Both blocked when the target is the last owner.
 */
import type { VaultRole } from "@brainz/contracts";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";

export interface MemberRecord {
  userId: string;
  email: string;
  name: string;
  role: VaultRole;
  createdAt: Date;
}

/** Persistence port (drizzle/D1 in prod via `membersDbFrom`, fakes in tests). */
export interface MembersDb {
  listMembers(vaultId: string): Promise<MemberRecord[]>;
  getMember(vaultId: string, userId: string): Promise<MemberRecord | null>;
  countOwners(vaultId: string): Promise<number>;
  updateRole(vaultId: string, userId: string, role: VaultRole): Promise<void>;
  deleteMember(vaultId: string, userId: string): Promise<void>;
}

/** Wire the members domain to the D1 control plane. */
export function membersDbFrom(db: Db): MembersDb {
  const memberSelect = {
    userId: schema.vaultMember.userId,
    email: schema.user.email,
    name: schema.user.name,
    role: schema.vaultMember.role,
    createdAt: schema.vaultMember.createdAt,
  };
  const toRecord = (r: {
    userId: string;
    email: string;
    name: string;
    role: string;
    createdAt: Date;
  }): MemberRecord => ({ ...r, role: r.role as VaultRole });
  return {
    listMembers: async (vaultId) => {
      const rows = await db
        .select(memberSelect)
        .from(schema.vaultMember)
        .innerJoin(schema.user, eq(schema.vaultMember.userId, schema.user.id))
        .where(eq(schema.vaultMember.vaultId, vaultId))
        .orderBy(schema.vaultMember.createdAt);
      return rows.map(toRecord);
    },
    getMember: async (vaultId, userId) => {
      const rows = await db
        .select(memberSelect)
        .from(schema.vaultMember)
        .innerJoin(schema.user, eq(schema.vaultMember.userId, schema.user.id))
        .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, userId)))
        .limit(1);
      return rows.length > 0 ? toRecord(rows[0]) : null;
    },
    countOwners: async (vaultId) => {
      const rows = await db
        .select({ n: count() })
        .from(schema.vaultMember)
        .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.role, "owner")));
      return rows[0]?.n ?? 0;
    },
    updateRole: async (vaultId, userId, role) => {
      await db
        .update(schema.vaultMember)
        .set({ role })
        .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, userId)));
    },
    deleteMember: async (vaultId, userId) => {
      await db
        .delete(schema.vaultMember)
        .where(and(eq(schema.vaultMember.vaultId, vaultId), eq(schema.vaultMember.userId, userId)));
      // Multi-vault OAuth: drop the vault from the user's ticked grants, so
      // being re-added later never silently restores a connection's access
      // (SPEC-CLOUD.md "Multi-vault grants"). "all" grants follow membership.
      await db
        .delete(schema.oauthGrantVault)
        .where(
          and(
            eq(schema.oauthGrantVault.vaultId, vaultId),
            inArray(
              schema.oauthGrantVault.grantId,
              db.select({ id: schema.oauthGrant.id }).from(schema.oauthGrant).where(eq(schema.oauthGrant.userId, userId)),
            ),
          ),
        );
    },
  };
}

export const LAST_OWNER_MESSAGE =
  "cannot remove or demote the last owner — a vault must always have at least one owner";

export type MemberOpResult =
  | { ok: true; member: MemberRecord }
  | { ok: false; status: number; message: string };

export type MemberRemoveResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Change a member's role (caller must already be verified as an OWNER).
 * Demoting the last owner is refused (409).
 */
export async function changeMemberRole(
  db: MembersDb,
  args: { vaultId: string; targetUserId: string; role: VaultRole },
): Promise<MemberOpResult> {
  const target = await db.getMember(args.vaultId, args.targetUserId);
  if (!target) return { ok: false, status: 404, message: "member not found" };
  if (target.role === args.role) return { ok: true, member: target };
  if (target.role === "owner" && (await db.countOwners(args.vaultId)) <= 1) {
    return { ok: false, status: 409, message: LAST_OWNER_MESSAGE };
  }
  await db.updateRole(args.vaultId, args.targetUserId, args.role);
  return { ok: true, member: { ...target, role: args.role } };
}

/**
 * Remove a member. Owners may remove anyone; a non-owner caller may only
 * remove THEMSELVES (self-leave). Removing the last owner is refused (409),
 * which also blocks the last owner's self-leave.
 */
export async function removeMember(
  db: MembersDb,
  args: { vaultId: string; targetUserId: string; callerUserId: string; callerRole: VaultRole },
): Promise<MemberRemoveResult> {
  const selfLeave = args.targetUserId === args.callerUserId;
  if (args.callerRole !== "owner" && !selfLeave) {
    return {
      ok: false,
      status: 403,
      message: "forbidden: only owners can remove other members (you may leave yourself)",
    };
  }
  const target = await db.getMember(args.vaultId, args.targetUserId);
  if (!target) return { ok: false, status: 404, message: "member not found" };
  if (target.role === "owner" && (await db.countOwners(args.vaultId)) <= 1) {
    return { ok: false, status: 409, message: LAST_OWNER_MESSAGE };
  }
  await db.deleteMember(args.vaultId, args.targetUserId);
  return { ok: true };
}
