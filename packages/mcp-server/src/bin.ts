#!/usr/bin/env node
/**
 * brainz-mcp — MCP stdio server over a Brainz vault.
 *
 * Vault dir: `--vault <dir>` arg, else BRAINZ_VAULT env, else cwd.
 * stdout is the MCP protocol channel; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Vault } from "@brainz/core";
import { createServer, resolveVaultDir } from "./server.js";

async function main(): Promise<void> {
  const dir = resolveVaultDir(process.argv.slice(2), process.env);
  const vault = await Vault.open(dir);
  const server = createServer(vault);

  const shutdown = (): void => {
    try {
      vault.close();
    } catch {
      // ignore — exiting anyway
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[brainz-mcp] serving vault "${vault.dir}" over stdio (embeddings: ${vault.embeddingStatus})`,
  );
}

main().catch((err) => {
  console.error("[brainz-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
