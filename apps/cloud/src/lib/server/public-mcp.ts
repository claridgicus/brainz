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
  emailExists(email: string): Promise<boolean>;
  /** Persist the account rows atomically. */
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

    // Per-IP rate limit: 5 signups per rolling hour.
    const recent = await deps.countRecentSignups(deps.ip, rateWindowStart(now));
    if (exceedsSignupRateLimit(recent)) {
      return fail(
        "rate limit exceeded: at most 5 signups per hour from one IP — wait and try again later",
      );
    }

    if (await deps.emailExists(email)) {
      return fail(
        `an account for ${email} already exists — your human can sign in at the /login page ` +
          "(enter this email, click the magic link) and create an API key from a vault's settings page instead",
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
      event: { id: crypto.randomUUID(), ip: deps.ip, createdAt: now },
    });

    // Mint the human's one-time sign-in link now that the user exists.
    const loginUrl = await deps.createLoginLink(email);

    const output: SignupOutput = {
      apiKey,
      loginUrl,
      vaultSlug,
      email,
    };
    return ok(output);
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
