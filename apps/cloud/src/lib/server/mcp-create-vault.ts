/**
 * The MCP `create_vault` tool (SPEC-CLOUD.md "Multi-vault grants" → "Creating
 * a vault over MCP"). Both variants create through the shared createVault
 * path ($lib/server/vaults), so the per-account cap and hourly limit apply,
 * and both add their extra rows in the SAME D1 batch as the vault:
 *
 * - OAuth (`/mcp`, OAUTH_MCP_TOOLS): the vault is owned by the signed-in user
 *   and joins the connection's grant (grantAddVaultStatements). A "single"
 *   connection becomes a two-vault one, so its tool surface changes (every
 *   vault tool takes `vault`, plus list_vaults): the result says so, and the
 *   call sends `notifications/tools/list_changed` on its own response stream
 *   for clients that re-list on it.
 * - `bz_` key on `/mcp/agent` (AGENT_KEY_MCP_TOOLS): the vault is owned by the
 *   key's account, and a new `bz_` key for it is minted in the same batch and
 *   returned once. The calling key stays bound to its own vault. `/mcp` never
 *   registers this variant: the directory endpoint hands out no API keys.
 */
import {
  createVaultInputSchema,
  type ConnectedVault,
  type CreateVaultOutput,
  type VaultRole,
} from "@brainz/contracts";
import { HttpError } from "./api-util";
import { generateApiKey, hashApiKey, keyPrefixOf } from "./api-keys";
import { fail, guarded, ok, type ToolCallContext, type ToolResult } from "./mcp";
import { coveredVaults, grantAddVaultStatements, type OAuthDb, type VaultScope } from "./oauth";
import { isOwnerExpired } from "./vault-access";
import { createVault, IF_VAULT_CREATED, type VaultCreateDb, type VaultLimits } from "./vaults";

export interface CreateVaultDeps {
  db: VaultCreateDb & OAuthDb;
  limits: VaultLimits;
  now?: () => Date;
}

/** The OAuth connection a call arrives on (from resolveAccessToken). */
export interface OAuthConnection {
  userId: string;
  grantId: string;
  vaultScope: VaultScope;
  vaults: readonly { id: string; slug: string; name: string; role: VaultRole }[];
}

/** The `bz_` key a call arrives on: its vault, whose owner owns the new vault. */
export interface KeyConnection {
  vault: { id: string; slug: string; name: string; ownerId: string };
}

/** Name of the key minted for a vault created over `/mcp/agent`. */
export const AGENT_CREATED_KEY_NAME = "create_vault (MCP)";

function connected(v: { id: string; slug: string; name: string; role: VaultRole }): ConnectedVault {
  return { id: v.id, slug: v.slug, name: v.name, role: v.role, readOnly: v.role === "viewer" };
}

/** Run createVault, turning its HttpErrors (limits, slug clash) into isError results. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; result: ToolResult }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, result: fail(err.message) };
    throw err;
  }
}

export function handleOAuthCreateVault(
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  deps: CreateVaultDeps,
  conn: OAuthConnection,
): Promise<ToolResult> {
  return guarded(async () => {
    const input = createVaultInputSchema.safeParse(args);
    if (!input.success) return fail(input.error.issues.map((i) => i.message).join("; "));
    const now = deps.now?.() ?? new Date();
    const created = await attempt(() =>
      createVault(deps.db, conn.userId, input.data, {
        limits: deps.limits,
        now,
        also: (newVaultId) =>
          grantAddVaultStatements(deps.db, {
            grantId: conn.grantId,
            vaultScope: conn.vaultScope,
            coveredVaultIds: conn.vaults.map((v) => v.id),
            newVaultId,
          }),
      }),
    );
    if (!created.ok) return created.result;
    const vault = created.value;

    const scope: VaultScope = conn.vaultScope === "all" ? "all" : "selected";
    const covered = (
      await coveredVaults(deps.db, { id: conn.grantId, userId: conn.userId, vaultScope: scope, anchorVaultId: null })
    ).filter((v) => !isOwnerExpired(v.ownerExpiresAt, now));
    const wasSingleVault = conn.vaultScope === "single";
    const output: CreateVaultOutput = {
      vault: { id: vault.id, slug: vault.slug, name: vault.name },
      vaults: covered.map(connected),
      includesFutureVaults: scope === "all",
      notice:
        `Vault "${vault.slug}" was created and added to this connection, which ` +
        `${wasSingleVault ? "now covers" : "covers"} ${covered.length} vaults` +
        (scope === "all" ? " (all your vaults, including ones you create or join later)" : "") +
        ". Every vault tool takes a `vault` argument (a slug or id from `vaults`), and list_vaults lists them." +
        (wasSingleVault
          ? " A client that cached this connection's earlier tool list shows the `vault` argument once it refreshes its tools."
          : ""),
    };
    // The single-vault surface just became the routed one. Stateless server:
    // the notification rides this call's response stream (best effort).
    if (wasSingleVault) {
      await ctx.sendNotification({ method: "notifications/tools/list_changed" }).catch(() => {});
    }
    return ok(output);
  });
}

export function handleAgentCreateVault(
  args: Record<string, unknown>,
  deps: CreateVaultDeps,
  conn: KeyConnection,
): Promise<ToolResult> {
  return guarded(async () => {
    const input = createVaultInputSchema.safeParse(args);
    if (!input.success) return fail(input.error.issues.map((i) => i.message).join("; "));
    const now = deps.now?.() ?? new Date();
    const key = generateApiKey();
    const keyHash = await hashApiKey(key);
    const created = await attempt(() =>
      createVault(deps.db, conn.vault.ownerId, input.data, {
        limits: deps.limits,
        now,
        also: (newVaultId) => [
          deps.db
            .prepare(
              `INSERT INTO api_key (id, vault_id, name, key_hash, key_prefix, created_at)
               SELECT ?, ?, ?, ?, ?, ? ${IF_VAULT_CREATED}`,
            )
            .bind(crypto.randomUUID(), newVaultId, AGENT_CREATED_KEY_NAME, keyHash, keyPrefixOf(key), now.getTime(), newVaultId),
        ],
      }),
    );
    if (!created.ok) return created.result;
    const vault = created.value;
    const output: CreateVaultOutput = {
      vault: { id: vault.id, slug: vault.slug, name: vault.name },
      // Keys carry editor-equivalent scope (vault-access, Wave M).
      vaults: [connected({ ...conn.vault, role: "editor" })],
      includesFutureVaults: false,
      apiKey: key,
      notice:
        `Vault "${vault.slug}" was created. This API key stays bound to vault "${conn.vault.slug}"; ` +
        `\`apiKey\` is a new key for "${vault.slug}" and appears only in this result.`,
    };
    return ok(output);
  });
}
