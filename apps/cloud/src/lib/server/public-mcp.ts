/**
 * PUBLIC MCP server — what an /mcp connection with NO Authorization header
 * gets: exactly one tool, `signup` (PUBLIC_MCP_TOOLS in @brainz/contracts).
 * A present-but-invalid bearer never reaches this server; it still 401s.
 *
 * `signup` provisions a complete account for an orchestrator's human:
 * a Better Auth-compatible user row (emailVerified false, NO credential
 * account row — auth is passwordless / magic-link only), a first vault, and a
 * working API key. It then mints a one-time MAGIC SIGN-IN LINK for the human
 * (`loginUrl`) — opening it signs them straight into the dashboard. Only the
 * SHA-256 hash of the key is stored; the plaintext key and the magic link
 * appear exactly once, in the tool result, and are never logged.
 *
 * Persistence + link minting go through the small `SignupDeps` port so the
 * flow is unit-testable without a Workers runtime; the route wires it to
 * drizzle/D1 (`signupDepsFromDb`) and to Better Auth's magic-link minting.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PUBLIC_MCP_TOOLS,
  signupInputSchema,
  type PublicMcpToolDef,
  type SignupInput,
  type SignupOutput,
} from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { count, eq, gt, and } from "drizzle-orm";
import { generateApiKey, hashApiKey, keyPrefixOf } from "./api-keys";
import { exceedsSignupRateLimitInclusive, rateWindowStart } from "./rate-limit";
import type { Db } from "./db";
import { schema } from "./db";
import { fail, guarded, ok, SERVER_NAME, SERVER_VERSION, type ToolResult } from "./mcp";

// ------------------------------------------------------------------- rows

export interface ProvisionedSignup {
  user: typeof schema.user.$inferSelect;
  vault: typeof schema.vault.$inferSelect;
  apiKey: typeof schema.apiKey.$inferSelect;
}

/**
 * The friendly, no-op-safe result for "this email already has an account".
 * Returned both by the fast-path emailExists pre-check AND when a concurrent
 * signup wins the race and our user insert hits the unique(email) constraint —
 * one authoritative message either way, pointing the human at /login. Reveals
 * only existence (the pre-check reveals that too), never any other account
 * detail.
 */
function alreadyExistsResult(email: string): ToolResult {
  return fail(
    `an account for ${email} already exists — your human can sign in at the /login page ` +
      "(enter this email, click the magic link) and create an API key from a vault's settings page instead",
  );
}

/**
 * Does `err` look like a SQLite/D1 UNIQUE-constraint violation on the user
 * email? The unique index is the integrity backstop for concurrent same-email
 * signups; when the emailExists pre-check races and loses, the user INSERT
 * throws this instead of an opaque failure. D1/libSQL surface it as a message
 * containing "UNIQUE constraint failed" (optionally naming user.email); we match
 * defensively on the stable "unique constraint" phrase.
 */
export function isUniqueEmailViolation(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes("unique constraint") || message.includes("unique_constraint");
}

/** Persistence + environment port for the signup flow (drizzle in prod, fakes in tests). */
export interface SignupDeps {
  now(): Date;
  /** Client IP (CF-Connecting-IP), the rate-limit key. */
  ip: string;
  /**
   * Record this signup ATTEMPT (one signup_events row) — called BEFORE
   * countRecentSignups so the count that follows includes it. See the
   * insert-then-count TOCTOU note in handleSignup.
   */
  recordSignupAttempt(event: typeof schema.signupEvent.$inferSelect): Promise<void>;
  countRecentSignups(ip: string, since: Date): Promise<number>;
  emailExists(email: string): Promise<boolean>;
  /**
   * Persist the account rows (user + vault + key) atomically. Throws a
   * UNIQUE-constraint error if the email was taken by a racing signup between
   * the emailExists pre-check and here; handleSignup maps that to the friendly
   * already-exists result (isUniqueEmailViolation).
   */
  persistSignup(p: ProvisionedSignup): Promise<void>;
  /**
   * Mint a one-time magic sign-in link for this email that lands on /dashboard.
   * Called AFTER the account rows are persisted so the link resolves to the
   * new user. Returns the full URL delivered to the human as `loginUrl`.
   */
  createLoginLink(email: string): Promise<string>;
}

export const DEFAULT_VAULT_NAME = "My vault";

/**
 * The signup flow. Returns an MCP tool result; the ONLY place the plaintext
 * API key and magic sign-in link ever appear.
 */
export async function handleSignup(input: SignupInput, deps: SignupDeps): Promise<ToolResult> {
  return guarded(async () => {
    const parsed = signupInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(`invalid signup input: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
    }
    const email = parsed.data.email.trim().toLowerCase();
    const now = deps.now();

    // Fast path: reject a known-taken email before doing any provisioning work
    // (and before consuming a rate-limit slot — a duplicate isn't a fresh
    // signup). Best-effort: the unique(email) index is the authoritative backstop
    // (see the persist catch below), which also covers the race where a
    // concurrent signup for the same email slips past this SELECT.
    if (await deps.emailExists(email)) {
      return alreadyExistsResult(email);
    }

    // Per-IP rate limit: 5 signups per rolling hour. TOCTOU-safe (audit HIGH):
    // RECORD this attempt FIRST, then count the window (now inclusive of it) and
    // reject if over the cap. Recording before counting means concurrent signups
    // each commit their own row before any counts, so at most `cap` requests can
    // observe a count at or below the cap — the check is atomic w.r.t. the
    // durable D1 counter, not the old bypassable count-then-insert. (A racing
    // duplicate that slips past the pre-check above still burns a slot here, but
    // that same race is caught by the unique-email backstop and returns the
    // friendly result — so it never provisions.)
    await deps.recordSignupAttempt({ id: crypto.randomUUID(), ip: deps.ip, createdAt: now });
    const recent = await deps.countRecentSignups(deps.ip, rateWindowStart(now));
    if (exceedsSignupRateLimitInclusive(recent)) {
      return fail(
        "rate limit exceeded: at most 5 signups per hour from one IP — wait and try again later",
      );
    }

    // Slug dedupe is unnecessary here: the vault is this brand-new user's
    // first, and slugs are only unique per owner.
    const vaultName = parsed.data.vaultName?.trim() || DEFAULT_VAULT_NAME;
    const vaultSlug = slugify(vaultName) || "my-vault";

    const apiKey = generateApiKey();
    const userId = crypto.randomUUID();
    const vaultId = crypto.randomUUID();

    // Better Auth-compatible user row: emailVerified false and NO credential
    // account row — the human signs in via a magic link, never a password.
    try {
      await deps.persistSignup({
        user: {
          id: userId,
          name: email.split("@")[0] || email,
          email,
          emailVerified: false,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
        vault: {
          id: vaultId,
          ownerId: userId,
          slug: vaultSlug,
          name: vaultName,
          createdAt: now,
          onboardedAt: null,
        },
        apiKey: {
          id: crypto.randomUUID(),
          vaultId,
          name: "agent-signup",
          keyHash: await hashApiKey(apiKey),
          keyPrefix: keyPrefixOf(apiKey),
          createdAt: now,
          lastUsedAt: null,
        },
      });
    } catch (err) {
      // Unique-email race: a concurrent signup for the same email won between
      // our emailExists pre-check and this insert, tripping the unique(email)
      // index. Data integrity held (one row wins); map the loser's constraint
      // error to the SAME friendly already-exists result the pre-check returns,
      // not an opaque failure. Any other error is a genuine failure — rethrow so
      // guarded() surfaces it as an isError result.
      if (isUniqueEmailViolation(err)) {
        return alreadyExistsResult(email);
      }
      throw err;
    }

    // Mint the human's one-time sign-in link now that the user exists.
    const loginUrl = await deps.createLoginLink(email);

    const output: SignupOutput = {
      apiKey,
      loginUrl,
      vaultSlug,
      email,
    };
    // First content block is the strict SignupOutput JSON (the wire shape).
    // Append a SECOND, human-oriented guidance block documenting the handoff-
    // exposure model for the loginUrl (task-agent-loginurl-hardening): the URL
    // is session-granting and is NOT emailed, so it must not be persisted in
    // orchestrator logs. It is single-use (consumed on first open) and expires
    // sooner than an emailed link (~10 min). This is additive — it does not
    // change the SignupOutput shape parsed from the first block.
    const base = ok(output);
    return {
      ...base,
      content: [
        ...base.content,
        {
          type: "text" as const,
          text:
            "SECURITY — handling loginUrl: this is a one-time, session-granting magic link for your " +
            "human, NOT an emailed link. Hand it to the human directly and do NOT log, echo, or persist " +
            "it (a logged loginUrl is a logged session). It is single-use (expires the moment it is first " +
            "opened) and expires in ~10 minutes — shorter than an emailed link — so deliver it promptly; " +
            "if it lapses, the human can request a fresh magic link at /login. The apiKey keeps working " +
            "regardless.",
        },
      ],
    };
  });
}

// ------------------------------------------------------------------ server

/** Build the public MCP server: registers PUBLIC_MCP_TOOLS only. */
export function buildPublicMcpServer(deps: SignupDeps): McpServer {
  const server = new McpServer({ name: `${SERVER_NAME}-public`, version: SERVER_VERSION });

  const handlers: Record<PublicMcpToolDef["name"], (args: SignupInput) => Promise<ToolResult>> = {
    signup: (args) => handleSignup(args, deps),
  };

  for (const tool of PUBLIC_MCP_TOOLS as readonly PublicMcpToolDef[]) {
    const handler = handlers[tool.name] as (args: Record<string, unknown>) => Promise<ToolResult>;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
      },
      async (args: Record<string, unknown>) => handler(args),
    );
  }

  return server;
}

// --------------------------------------------------------------- prod deps

/**
 * Wire SignupDeps to the D1 control plane (all account rows in one atomic
 * batch) and to a magic-link minter. `createLoginLink` is supplied by the
 * route, where the per-request Better Auth instance + request headers live.
 */
export function signupDepsFromDb(
  db: Db,
  opts: { ip: string; createLoginLink: (email: string) => Promise<string> },
): SignupDeps {
  return {
    now: () => new Date(),
    ip: opts.ip,
    createLoginLink: opts.createLoginLink,
    // Record the rate-limit attempt FIRST (its own commit) so the count that
    // follows includes it — the TOCTOU-safe insert-then-count order.
    recordSignupAttempt: async (event) => {
      await db.insert(schema.signupEvent).values(event);
    },
    countRecentSignups: async (ip, since) => {
      const rows = await db
        .select({ n: count() })
        .from(schema.signupEvent)
        .where(and(eq(schema.signupEvent.ip, ip), gt(schema.signupEvent.createdAt, since)));
      return rows[0]?.n ?? 0;
    },
    emailExists: async (email) => {
      const rows = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .limit(1);
      return rows.length > 0;
    },
    // Account rows only (user + vault + key); the signup_events row was already
    // recorded by recordSignupAttempt. A racing same-email signup trips the
    // unique(email) index here — handleSignup maps that to the friendly result.
    persistSignup: async (p) => {
      await db.batch([
        db.insert(schema.user).values(p.user),
        db.insert(schema.vault).values(p.vault),
        db.insert(schema.apiKey).values(p.apiKey),
      ]);
    },
  };
}
