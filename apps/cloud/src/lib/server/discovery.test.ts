/**
 * MCP discovery documents must not drift from the shipped contracts.
 *
 * Three artifacts advertise the server for auto-discovery:
 *   - static/.well-known/mcp.json            (well-known discovery, SEP-2127 lineage)
 *   - static/.well-known/mcp/server-card.json (SEP-1649 alias — identical content)
 *   - server.json                             (the MCP Registry publish artifact)
 *
 * All three are hand-authored JSON (the endpoint/name/description are deploy
 * constants, not runtime values), so these tests are the guard: tool lists must
 * match the contracts registries, versions must match SERVER_VERSION, the
 * remote URL must be the production /mcp endpoint, and the registry artifact
 * must equal the well-known card minus `_meta` (the registry schema caps
 * `description` at 100 chars, which we also enforce here).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// auth.ts imports getRequestEvent from $app/server at module load; it isn't
// available outside the SvelteKit runtime, so stub it (same as auth.test.ts).
vi.mock("$app/server", () => ({ getRequestEvent: () => ({}) }));
import {
  CLOUD_MCP_TOOL_NAMES,
  MCP_TOOL_NAMES,
  PUBLIC_MCP_TOOL_NAMES,
} from "@brainz/contracts";
import { PRODUCTION_ORIGIN } from "./auth";
import { SERVER_VERSION } from "./mcp";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(appRoot, relPath), "utf8")) as Record<string, unknown>;
}

const wellKnown = readJson("static/.well-known/mcp.json");
const serverCard = readJson("static/.well-known/mcp/server-card.json");
const registryDoc = readJson("server.json");

describe("MCP discovery documents", () => {
  it("well-known card and SEP-1649 alias are identical", () => {
    expect(serverCard).toEqual(wellKnown);
  });

  it("registry server.json equals the well-known card minus _meta", () => {
    const { _meta, ...card } = wellKnown;
    expect(_meta).toBeDefined();
    expect(registryDoc).toEqual(card);
  });

  it("advertises the production endpoint, name, and current version", () => {
    for (const doc of [wellKnown, registryDoc]) {
      expect(doc.name).toBe("ai.brownmatter/brainz");
      expect(doc.version).toBe(SERVER_VERSION);
      expect(doc.websiteUrl).toBe(PRODUCTION_ORIGIN);
      const remotes = doc.remotes as Array<{ type: string; url: string }>;
      expect(remotes).toHaveLength(1);
      expect(remotes[0]).toMatchObject({
        type: "streamable-http",
        url: `${PRODUCTION_ORIGIN}/mcp`,
      });
    }
  });

  it("keeps description within the registry's 100-char cap", () => {
    expect((registryDoc.description as string).length).toBeLessThanOrEqual(100);
  });

  it("advertises Authorization as optional + secret (public signup exists)", () => {
    const [remote] = wellKnown.remotes as Array<{
      headers: Array<{ name: string; isRequired: boolean; isSecret: boolean }>;
    }>;
    const auth = remote.headers.find((h) => h.name === "Authorization");
    expect(auth).toMatchObject({ isRequired: false, isSecret: true });
  });

  it("tool lists in _meta match the contracts registries exactly", () => {
    const meta = (wellKnown._meta as Record<string, unknown>)["ai.brownmatter/brainz"] as {
      unauthenticatedTools: string[];
      authenticatedTools: string[];
    };
    expect(meta.unauthenticatedTools).toEqual([...PUBLIC_MCP_TOOL_NAMES]);
    expect(meta.authenticatedTools).toEqual([...MCP_TOOL_NAMES, ...CLOUD_MCP_TOOL_NAMES]);
  });

  it("links the public privacy, terms and support pages directories require", () => {
    const meta = (wellKnown._meta as Record<string, unknown>)["ai.brownmatter/brainz"];
    expect(meta).toMatchObject({
      privacyPolicy: "https://brownmatter.ai/privacy",
      termsOfService: "https://brownmatter.ai/terms",
      support: "https://brownmatter.ai/support",
      supportEmail: "support@brownmatter.ai",
    });
  });
});
