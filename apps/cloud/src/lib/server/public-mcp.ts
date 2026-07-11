/**
 * PUBLIC MCP server — what an /mcp connection with NO Authorization header
 * gets: two tools, `signup` and `sign_in` (PUBLIC_MCP_TOOLS in @brainz/contracts).
 * A present-but-invalid bearer never reaches this server; it still 401s.
 *
 * Signup v2 (Wave G — agent self-signup guardrails): `signup` provisions an
 * ANONYMOUS, PROVISIONAL workspace — a Better Auth-compatible user row with a
 * placeholder identity (`unclaimed-<userId>@pending.brainz.invalid`, name
 * "Unclaimed workspace", emailVerified false, expires_at = now + 7 days), a
 * first vault, and a working API key. NO login or claim URL is ever returned
 * (a URL in an agent's tool result sits in orchestrator logs and proves
 * nothing about a human). Persistence requires the claim flow ($lib/server/
 * claim): the human approves an EMAILED link. Supplying `email` here merely
 * fires that same claim request; `claimEmailSent: true` is reported regardless
 * of the address's eligibility (no account-existence oracle — and no
 * "already exists" signup error either, since no email binds at signup).
 *
 * `sign_in` triggers Better Auth to EMAIL a magic sign-in link to an existing
 * human's inbox. Unlike `signup` it returns NO URL — the human must action the
 * link from their inbox; the tool result only confirms an email is on its way,
 * with no account-existence leak. It is rate-limited exactly like the login
 * page's magic-link request path (5/hour/email, 20/hour/IP), reusing the shared
 * magic_link_events guard.
 *
 * TOCTOU-safe rate limiting (audit HIGH): the per-IP signup limiter RECORDS the
 * attempt row BEFORE counting the window, so the count includes this attempt and
 * we reject only once it has PASSED the cap (inclusive predicate). Recording
 * before counting makes the check atomic w.r.t. the durable D1 counter — the old
 * count-then-insert order was a bypassable race under parallelism.
 *
 * Only the SHA-256 hash of the API key is stored; the plaintext appears
 * exactly once, in the signup tool result, and is never logged. Persistence +
 * the claim/sign-in requests go through the small `SignupDeps` port so the flow
 * is unit-testable without a Workers runtime; the route wires it to drizzle/D1
 * (`signupDepsFromDb`) and to the claim / magic-link domains.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PUBLIC_MCP_TOOLS,
  signInInputSchema,
  signupInputSchema,
  type PublicMcpToolDef,
  type SignInInput,
  type SignInOutput,
  type SignupInput,
  type SignupOutput,
} from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { count, eq, gt, and } from "drizzle-orm";
import { generateApiKey, hashApiKey, keyPrefixOf } from "./api-keys";
import { placeholderEmail, SIGNUP_EXPIRY_MS, UNCLAIMED_WORKSPACE_NAME } from "./claim";
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

/** Persistence + environment port for the signup / sign-in flows (drizzle in prod, fakes in tests). */
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
  /** Persist the account rows (user + vault + key) atomically. */
  persistSignup(p: ProvisionedSignup): Promise<void>;
  /**
   * Fire a claim request for the freshly provisioned owner (same semantics as
   * the authenticated `claim` tool: approval link EMAILED to the human, or a
   * notice email to an already-registered address — never returned). Called
   * only when the caller supplied `email`, AFTER the rows are persisted.
   * Failures must not fail the signup — `claimEmailSent` reports true
   * regardless of the address's eligibility.
   */
  requestClaim(args: { userId: string; email: string }): Promise<void>;
  /**
   * Handle a `sign_in` request: rate-limit it (5/hour/email, 20/hour/IP, atomic)
   * and, if not throttled, trigger Better Auth to EMAIL a magic sign-in link.
   * NEVER returns a URL. Returns whether the request was throttled so the tool
   * can surface a friendly 429 message; everything else stays a generic
   * no-existence-leak confirmation. Delivery failures never surface.
   */
  requestSignIn(args: { email: string }): Promise<{ throttled: boolean }>;
}

export const DEFAULT_VAULT_NAME = "My vault";

/**
 * The signup flow. Returns an MCP tool result; the ONLY place the plaintext
 * API key ever appears. Never returns a URL of any kind.
 */
export async function handleSignup(input: SignupInput, deps: SignupDeps): Promise<ToolResult> {
  return guarded(async () => {
    const parsed = signupInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(`invalid signup input: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
    }
    const now = deps.now();

    // Per-IP rate limit: 5 signups per rolling hour. TOCTOU-safe (audit HIGH):
    // RECORD this attempt FIRST, then count the window (now inclusive of it) and
    // reject if over the cap. Recording before counting means concurrent signups
    // each commit their own row before any counts, so at most `cap` requests can
    // observe a count at or below the cap — the check is atomic w.r.t. the
    // durable D1 counter, not the old bypassable count-then-insert.
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
    const expiresAt = new Date(now.getTime() + SIGNUP_EXPIRY_MS);

    // Anonymous provisional account: placeholder identity, unverified, and
    // EXPIRING — the /claim approval flow is the only path to permanence.
    await deps.persistSignup({
      user: {
        id: userId,
        name: UNCLAIMED_WORKSPACE_NAME,
        email: placeholderEmail(userId),
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
        expiresAt,
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

    // Optional email: fire the claim request (approval link EMAILED to the
    // human — never returned here). claimEmailSent is true whenever an email
    // was supplied, regardless of eligibility or delivery: reporting anything
    // finer would be an account-existence oracle.
    const email = parsed.data.email?.trim().toLowerCase();
    if (email) {
      try {
        await deps.requestClaim({ userId, email });
      } catch {
        // Deliberately swallowed — see above.
      }
    }

    const output: SignupOutput = {
      apiKey,
      vaultSlug,
      expiresAt: expiresAt.toISOString(),
      claimEmailSent: Boolean(email),
    };
    // First content block is the strict SignupOutput JSON (the wire shape).
    // A second, additive guidance block teaches the guardrail model: secret
    // key, 7-day unclaimed expiry, claim-to-persist. No URL appears anywhere.
    const base = ok(output);
    return {
      ...base,
      content: [
        ...base.content,
        {
          type: "text" as const,
          text:
            "SECURITY & PERSISTENCE — keep the apiKey SECRET (never log, echo, or print it; a logged " +
            "key is a leaked workspace). This workspace is PROVISIONAL: it expires on " +
            `${expiresAt.toISOString().slice(0, 10)} unless a human claims it. To persist it, call the ` +
            "authenticated `claim` tool with your human's email — the approval link is EMAILED to them " +
            "and never shown to you; ask your human to open that email and approve (never ask them to " +
            "forward it).",
        },
      ],
    };
  });
}

/**
 * The generic, no-existence-leak sign-in response — identical whether or not the
 * address has an account, and whether or not the request was throttled at the
 * delivery layer (a trip returns a different, rate-limit message; a pass returns
 * this). NEVER contains a URL: the human actions the link from their inbox.
 */
const SIGN_IN_CONFIRMATION =
  "if that email has an account, a sign-in link is on its way — ask your human to open their inbox " +
  "and click it. The link is EMAILED only; it is never returned here, so do not ask for it.";

/**
 * The `sign_in` flow: trigger Better Auth to EMAIL a magic sign-in link to an
 * existing human's inbox. CRITICAL: this returns NO login URL — the human must
 * action the emailed link. Rate-limited exactly like the login page's magic-link
 * request path (5/hour/email, 20/hour/IP), reusing the shared guard. The
 * response never reveals whether the email has an account.
 */
export async function handleSignIn(
  input: SignInInput | Record<string, unknown>,
  deps: SignupDeps,
): Promise<ToolResult> {
  return guarded(async () => {
    const parsed = signInInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(`invalid sign_in input: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
    }
    const email = parsed.data.email.trim().toLowerCase();

    const { throttled } = await deps.requestSignIn({ email });
    if (throttled) {
      return fail(
        "rate limit exceeded: at most 5 sign-in emails per hour per address (20/hour per IP) — " +
          "wait and try again later",
      );
    }

    const output: SignInOutput = { status: "sent" };
    const base = ok(output);
    return {
      ...base,
      content: [
        ...base.content,
        { type: "text" as const, text: SIGN_IN_CONFIRMATION },
      ],
    };
  });
}

// ------------------------------------------------------------------ server

/** Build the public MCP server: registers PUBLIC_MCP_TOOLS only. */
export function buildPublicMcpServer(deps: SignupDeps): McpServer {
  const server = new McpServer({ name: `${SERVER_NAME}-public`, version: SERVER_VERSION });

  const handlers: Record<
    PublicMcpToolDef["name"],
    (args: Record<string, unknown>) => Promise<ToolResult>
  > = {
    signup: (args) => handleSignup(args, deps),
    sign_in: (args) => handleSignIn(args, deps),
  };

  for (const tool of PUBLIC_MCP_TOOLS as readonly PublicMcpToolDef[]) {
    const handler = handlers[tool.name];
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
 * batch) and to the claim + magic-link domains. `requestClaim` and
 * `requestSignIn` are supplied by the route, where the mailer + request origin
 * live.
 */
export function signupDepsFromDb(
  db: Db,
  opts: {
    ip: string;
    requestClaim: (args: { userId: string; email: string }) => Promise<void>;
    requestSignIn: (args: { email: string }) => Promise<{ throttled: boolean }>;
  },
): SignupDeps {
  return {
    now: () => new Date(),
    ip: opts.ip,
    requestClaim: opts.requestClaim,
    requestSignIn: opts.requestSignIn,
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
    // Account rows only (user + vault + key); the signup_events row was already
    // recorded by recordSignupAttempt.
    persistSignup: async (p) => {
      await db.batch([
        db.insert(schema.user).values(p.user),
        db.insert(schema.vault).values(p.vault),
        db.insert(schema.apiKey).values(p.apiKey),
      ]);
    },
  };
}
