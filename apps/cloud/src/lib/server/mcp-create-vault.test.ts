/**
 * The MCP `create_vault` tool over the migrated control plane, driven through
 * a real MCP client: the OAuth variant adds the vault to the connection's
 * grant (single → selected, selected + 1, all unchanged) and announces the
 * single → multi surface change; the `/mcp/agent` key variant mints a key for
 * the new vault in the same batch; both refuse past the limits with isError
 * and leave nothing behind.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_KEY_MCP_TOOLS,
  createVaultOutputSchema,
  OAUTH_MCP_TOOLS,
  PUBLIC_VAULT_READ_TOOL_NAMES,
  type CreateVaultOutput,
} from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-keys";
import { fakeD1, seedOwner } from "./fake-d1.testutil";
import { buildMcpServer, buildMultiVaultMcpServer } from "./mcp";
import {
  AGENT_CREATED_KEY_NAME,
  handleAgentCreateVault,
  handleOAuthCreateVault,
  type OAuthConnection,
} from "./mcp-create-vault";
import { coveredVaults, type VaultScope } from "./oauth";
import type { VaultClient } from "./vault-client";
import type { VaultLimits } from "./vaults";

const LIMITS: VaultLimits = { maxVaultsPerUser: 20, createsPerHour: 10 };
/** create_vault never touches a vault DO. */
const NO_DO = {} as VaultClient;

type D1 = ReturnType<typeof fakeD1>;

function setup() {
  const d1 = fakeD1();
  seedOwner(d1, "u1", "v1");
  member(d1, "v1", "u1", "owner");
  return d1;
}

function member(d1: D1, vaultId: string, userId: string, role: string) {
  d1.db
    .prepare(`INSERT INTO vault_member (id, vault_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), vaultId, userId, role, Date.now());
}

function vault(d1: D1, id: string, ownerId = "u1") {
  d1.db
    .prepare(`INSERT INTO vault (id, owner_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, ownerId, id, id, Date.now());
}

function grant(d1: D1, scope: VaultScope, vaultIds: string[], { joinRows = true } = {}) {
  d1.db
    .prepare(
      `INSERT INTO oauth_grant (id, client_id, user_id, vault_id, scope, created_at, vault_scope) VALUES ('g1', 'c1', 'u1', ?, 'vault', ?, ?)`,
    )
    .run(vaultIds[0] ?? null, Date.now(), scope);
  if (scope === "all" || !joinRows) return;
  for (const id of vaultIds) d1.db.prepare(`INSERT INTO oauth_grant_vault (grant_id, vault_id) VALUES ('g1', ?)`).run(id);
}

async function conn(d1: D1, scope: VaultScope, anchor: string | null = "v1"): Promise<OAuthConnection> {
  const vaults = await coveredVaults(d1, { id: "g1", userId: "u1", vaultScope: scope, anchorVaultId: anchor });
  return { userId: "u1", grantId: "g1", vaultScope: scope, vaults };
}

const grantScope = (d1: D1) => (d1.db.prepare(`SELECT vault_scope AS s FROM oauth_grant WHERE id = 'g1'`).get() as { s: string }).s;
const joinRows = (d1: D1) =>
  (d1.db.prepare(`SELECT vault_id FROM oauth_grant_vault WHERE grant_id = 'g1' ORDER BY vault_id`).all() as { vault_id: string }[]).map(
    (r) => r.vault_id,
  );

/** An OAuth single-vault (or viewer) server with create_vault, plus a client that records list_changed. */
async function oauthClient(d1: D1, c: OAuthConnection, opts: { viewer?: boolean; limits?: VaultLimits } = {}) {
  const accountTools = OAUTH_MCP_TOOLS.map((def) => ({
    def,
    handler: (args: Record<string, unknown>, ctx: Parameters<typeof handleOAuthCreateVault>[1]) =>
      handleOAuthCreateVault(args, ctx, { db: d1, limits: opts.limits ?? LIMITS }, c),
  }));
  const server =
    c.vaultScope === "single"
      ? buildMcpServer(NO_DO, {
          notices: "neutral",
          accountTools,
          ...(opts.viewer ? { only: PUBLIC_VAULT_READ_TOOL_NAMES } : {}),
        })
      : buildMultiVaultMcpServer({
          vaults: c.vaults,
          includesFutureVaults: c.vaultScope === "all",
          open: () => ({ client: NO_DO }),
          accountTools,
        });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, listChanged: () => listChanged };
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "create_vault", arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return { isError: result.isError === true, text, output: result.isError ? null : createVaultOutputSchema.parse(JSON.parse(text)) };
}

describe("create_vault on an OAuth connection", () => {
  it("single → selected: both vaults in the grant, the result says so, and tools/list_changed is sent", async () => {
    const d1 = setup();
    grant(d1, "single", ["v1"]);
    const { client, listChanged } = await oauthClient(d1, await conn(d1, "single"));
    const { output } = await call(client, { name: "Second brain" });
    const out = output as CreateVaultOutput;
    expect(out.vault.slug).toBe("second-brain");
    expect(out.vaults.map((v) => v.slug)).toEqual(["second-brain", "v1"]); // ordered by name
    expect(out.vaults.every((v) => v.role === "owner" && !v.readOnly)).toBe(true);
    expect(out.includesFutureVaults).toBe(false);
    expect(out.apiKey).toBeUndefined();
    expect(out.notice).toContain("now covers 2 vaults");
    expect(out.notice).toContain("`vault` argument");
    expect(out.notice).toContain("list_vaults");
    expect(grantScope(d1)).toBe("selected");
    expect(joinRows(d1).sort()).toEqual([out.vault.id, "v1"].sort());
    // The vault is the user's: owner membership.
    expect(d1.db.prepare(`SELECT role FROM vault_member WHERE vault_id = ? AND user_id = 'u1'`).get(out.vault.id)).toEqual({
      role: "owner",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(listChanged()).toBe(1);
    // The next request resolves the grant as a two-vault connection.
    expect((await conn(d1, "selected")).vaults).toHaveLength(2);
  });

  it("a deploy-window single grant (no join row) gets explicit rows for both vaults", async () => {
    const d1 = setup();
    grant(d1, "single", ["v1"], { joinRows: false });
    const { client } = await oauthClient(d1, await conn(d1, "single"));
    const { output } = await call(client, { name: "Fresh" });
    expect(joinRows(d1).sort()).toEqual([output!.vault.id, "v1"].sort());
    expect(grantScope(d1)).toBe("selected");
  });

  it("a viewer single-vault connection lists create_vault next to the read tools, and gains the vault", async () => {
    const d1 = fakeD1();
    seedOwner(d1, "owner", "shared");
    seedOwner(d1, "u1", "unused");
    member(d1, "shared", "u1", "viewer");
    grant(d1, "single", ["shared"]);
    const c = await conn(d1, "single", "shared");
    const { client } = await oauthClient(d1, c, { viewer: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...PUBLIC_VAULT_READ_TOOL_NAMES, "create_vault"]);
    const { output } = await call(client, { name: "Mine" });
    expect(output!.vaults.map((v) => [v.slug, v.role])).toEqual([
      ["mine", "owner"],
      ["shared", "viewer"],
    ]);
  });

  it("selected: gains one join row, scope unchanged, no list_changed (same tools)", async () => {
    const d1 = setup();
    vault(d1, "v2");
    member(d1, "v2", "u1", "owner");
    grant(d1, "selected", ["v1", "v2"]);
    const { client, listChanged } = await oauthClient(d1, await conn(d1, "selected"));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names[0]).toBe("list_vaults");
    expect(names.at(-1)).toBe("create_vault");
    const { output } = await call(client, { name: "Third" });
    expect(output!.vaults).toHaveLength(3);
    expect(output!.notice).toContain("covers 3 vaults");
    expect(output!.notice).not.toContain("now covers");
    expect(joinRows(d1)).toHaveLength(3);
    expect(grantScope(d1)).toBe("selected");
    await new Promise((r) => setTimeout(r, 0));
    expect(listChanged()).toBe(0);
  });

  it("all: already covers the new vault (no join rows), includesFutureVaults is true", async () => {
    const d1 = setup();
    grant(d1, "all", []);
    const { client } = await oauthClient(d1, await conn(d1, "all"));
    const { output } = await call(client, { name: "Another" });
    expect(output!.includesFutureVaults).toBe(true);
    expect(output!.vaults.map((v) => v.slug)).toEqual(["another", "v1"]);
    expect(output!.notice).toContain("including ones you create or join later");
    expect(joinRows(d1)).toEqual([]);
    expect(grantScope(d1)).toBe("all");
  });

  it("at the vault cap: an isError naming the limit, and neither vault nor grant changes", async () => {
    const d1 = setup();
    grant(d1, "single", ["v1"]);
    const { client, listChanged } = await oauthClient(d1, await conn(d1, "single"), {
      limits: { maxVaultsPerUser: 1, createsPerHour: 10 },
    });
    const res = await call(client, { name: "Too many" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("vault limit reached");
    expect(grantScope(d1)).toBe("single");
    expect(joinRows(d1)).toEqual(["v1"]);
    expect((d1.db.prepare(`SELECT COUNT(*) AS n FROM vault`).get() as { n: number }).n).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(listChanged()).toBe(0);
  });

  it("past the hourly limit and on a slug clash: isError results, never a throw", async () => {
    const d1 = setup();
    grant(d1, "selected", ["v1"]);
    const { client } = await oauthClient(d1, await conn(d1, "selected"), {
      // The seeded v1 was created just now, so it counts: one more fits.
      limits: { maxVaultsPerUser: 20, createsPerHour: 2 },
    });
    expect((await call(client, { name: "one" })).isError).toBe(false);
    const clash = await call(client, { name: "v1" });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("already exists");
    const limited = await call(client, { name: "two" });
    expect(limited.isError).toBe(true);
    expect(limited.text).toContain("per hour");
  });
});

describe("create_vault on a bz_ key (/mcp/agent)", () => {
  const keyVault = { id: "v1", slug: "v1", name: "v1", ownerId: "u1" };

  it("creates a vault owned by the key's account and returns a new key for it, stored hashed", async () => {
    const d1 = setup();
    const result = await handleAgentCreateVault({ name: "Agent vault" }, { db: d1, limits: LIMITS }, { vault: keyVault });
    expect(result.isError).toBeFalsy();
    const out = createVaultOutputSchema.parse(JSON.parse(result.content[0].text));
    expect(out.vault.slug).toBe("agent-vault");
    expect(out.vaults).toEqual([{ id: "v1", slug: "v1", name: "v1", role: "editor", readOnly: false }]);
    expect(out.apiKey).toMatch(/^bz_/);
    expect(out.notice).toContain('stays bound to vault "v1"');
    const key = d1.db.prepare(`SELECT vault_id, name, key_hash FROM api_key`).get() as Record<string, string>;
    expect(key).toEqual({ vault_id: out.vault.id, name: AGENT_CREATED_KEY_NAME, key_hash: await hashApiKey(out.apiKey!) });
    expect((d1.db.prepare(`SELECT owner_id FROM vault WHERE id = ?`).get(out.vault.id) as { owner_id: string }).owner_id).toBe("u1");
  });

  it("a refused create mints no key", async () => {
    const d1 = setup();
    const result = await handleAgentCreateVault(
      { name: "Nope" },
      { db: d1, limits: { maxVaultsPerUser: 1, createsPerHour: 10 } },
      { vault: keyVault },
    );
    expect(result.isError).toBe(true);
    expect((d1.db.prepare(`SELECT COUNT(*) AS n FROM api_key`).get() as { n: number }).n).toBe(0);
  });

  it("the key variant shares the OAuth tool's name and shapes", () => {
    expect(AGENT_KEY_MCP_TOOLS[0].name).toBe(OAUTH_MCP_TOOLS[0].name);
    expect(AGENT_KEY_MCP_TOOLS[0].outputSchema).toBe(createVaultOutputSchema);
  });
});
