/**
 * PUBLIC MCP server — what an /mcp connection with NO Authorization header
 * gets: exactly one tool, `signup` (PUBLIC_MCP_TOOLS in @brainz/contracts).
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
 * Only the SHA-256 hash of the API key is stored; the plaintext appears
 * exactly once, in the tool result, and is never logged. Persistence + the
 * claim request go through the small `SignupDeps` port so the flow is
 * unit-testable without a Workers runtime; the route wires it to drizzle/D1
 * (`signupDepsFromDb`) and to the claim domain.
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
import { placeholderEmail, SIGNUP_EXPIRY_MS, UNCLAIMED_WORKSPACE_NAME } from "./claim";
import { exceedsSignupRateLimit, rateWindowStart } from "./rate-limit";
import type { Db } from "./db";
import { schema } from "./db";
import { fail, guarded, ok, SERVER_NAME, SERVER_VERSION, type ToolResult } from "./mcp";

// ------------------------------------------------------------------- rows

export interface ProvisionedSignup {
  user: typeof schema.user.$inferSelect;
  vault: typeof schema.vault.$inferSelect;
  apiKey: typeof schema.apiKey.$inferSelect;
  event: typeof schema.signupEvent.$inferSelect;
}

/** Persistence + environment port for the signup flow (drizzle in prod, fakes in tests). */
export interface SignupDeps {
  now(): Date;
  /** Client IP (CF-Connecting-IP), the rate-limit key. */
  ip: string;
  countRecentSignups(ip: string, since: Date): Promise<number>;
  /** Persist the account rows atomically. */
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

    // Per-IP rate limit: 5 signups per rolling hour.
    const recent = await deps.countRecentSignups(deps.ip, rateWindowStart(now));
    if (exceedsSignupRateLimit(recent)) {
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
      event: { id: crypto.randomUUID(), ip: deps.ip, createdAt: now },
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
 * batch) and to the claim domain. `requestClaim` is supplied by the route,
 * where the mailer + request origin live.
 */
export function signupDepsFromDb(
  db: Db,
  opts: { ip: string; requestClaim: (args: { userId: string; email: string }) => Promise<void> },
): SignupDeps {
  return {
    now: () => new Date(),
    ip: opts.ip,
    requestClaim: opts.requestClaim,
    countRecentSignups: async (ip, since) => {
      const rows = await db
        .select({ n: count() })
        .from(schema.signupEvent)
        .where(and(eq(schema.signupEvent.ip, ip), gt(schema.signupEvent.createdAt, since)));
      return rows[0]?.n ?? 0;
    },
    persistSignup: async (p) => {
      await db.batch([
        db.insert(schema.user).values(p.user),
        db.insert(schema.vault).values(p.vault),
        db.insert(schema.apiKey).values(p.apiKey),
        db.insert(schema.signupEvent).values(p.event),
      ]);
    },
  };
}
