/**
 * /claim/[token] — human-side handoff for agent-provisioned accounts.
 *
 * The public MCP `signup` tool created the account WITHOUT a credential
 * account row, so email+password sign-in fails until this page runs. A valid
 * (unexpired, unclaimed) token shows the account email and a set-password
 * form; submitting creates the Better Auth credential account row (same
 * PBKDF2 format sign-in verifies), marks the claim used, signs the human in,
 * and lands them on /dashboard.
 *
 * The token is only ever compared by SHA-256 hash and never logged.
 */
import { fail, redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { claimState, hashClaimToken, isClaimTokenFormat } from "$lib/server/claims";
import { createDb, schema } from "$lib/server/db";
import { hashPassword } from "$lib/server/password";
import type { Actions, PageServerLoad } from "./$types";

/** Matches the signup form's minlength and Better Auth's default password policy. */
const MIN_PASSWORD_LENGTH = 8;

type ClaimRow = {
  claim: typeof schema.accountClaim.$inferSelect;
  user: typeof schema.user.$inferSelect;
};

async function findClaim(
  db: ReturnType<typeof createDb>,
  token: string,
): Promise<ClaimRow | null> {
  if (!isClaimTokenFormat(token)) return null;
  const tokenHash = await hashClaimToken(token);
  const rows = await db
    .select({ claim: schema.accountClaim, user: schema.user })
    .from(schema.accountClaim)
    .innerJoin(schema.user, eq(schema.accountClaim.userId, schema.user.id))
    .where(eq(schema.accountClaim.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export const load: PageServerLoad = async ({ params, platform }) => {
  if (!platform?.env) return { state: "unknown" as const, email: null };
  const row = await findClaim(createDb(platform.env.DB), params.token);
  if (!row) return { state: "unknown" as const, email: null };
  const state = claimState(row.claim, new Date());
  return { state, email: state === "valid" ? row.user.email : null };
};

export const actions: Actions = {
  default: async (event) => {
    const { params, platform, request, locals } = event;
    if (!platform?.env) return fail(500, { error: "platform bindings unavailable" });
    const db = createDb(platform.env.DB);

    const form = await request.formData();
    const password = form.get("password");
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    // Re-validate the token at submit time: single-use and time-boxed.
    const row = await findClaim(db, params.token);
    if (!row) return fail(404, { error: "This claim link is invalid." });
    const state = claimState(row.claim, new Date());
    if (state !== "valid") {
      return fail(410, {
        error:
          state === "claimed"
            ? "This claim link has already been used."
            : "This claim link has expired.",
      });
    }

    // Belt-and-braces: never create a second credential account.
    const existing = await db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(eq(schema.account.userId, row.user.id))
      .limit(1);
    if (existing.length > 0) return fail(409, { error: "This account has already been claimed." });

    const now = new Date();
    // Credential account row exactly as Better Auth's sign-up creates it:
    // providerId "credential", accountId = user id, password = PBKDF2 hash.
    await db.batch([
      db.insert(schema.account).values({
        id: crypto.randomUUID(),
        userId: row.user.id,
        accountId: row.user.id,
        providerId: "credential",
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(schema.accountClaim)
        .set({ claimedAt: now })
        .where(eq(schema.accountClaim.id, row.claim.id)),
    ]);

    // Sign the human in via the Better Auth API (sveltekitCookies sets the
    // session cookie on this event). If it somehow fails, the credential is
    // set — /login works — so degrade to that.
    let signedIn = false;
    try {
      await locals.auth.api.signInEmail({
        body: { email: row.user.email, password },
        headers: request.headers,
      });
      signedIn = true;
    } catch {
      signedIn = false;
    }
    redirect(303, signedIn ? "/dashboard" : "/login");
  },
};
