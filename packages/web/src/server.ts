#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Vault } from "@brainz/core";
import { createApp } from "./app.js";

const HELP = `brainz-web — local graph view for a Brainz vault

Usage: brainz-web [--vault <dir>] [--port <n>]

  --vault <dir>   Vault directory (default: $BRAINZ_VAULT, else cwd)
  --port <n>      Port to listen on (default: 4680)
  --help          Show this help
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vault: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const dir = path.resolve(values.vault ?? process.env["BRAINZ_VAULT"] ?? process.cwd());
  const port = values.port !== undefined ? Number(values.port) : 4680;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`brainz-web: invalid port: ${values.port}`);
    process.exit(1);
  }

  const vault = await Vault.open(dir);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  const server = createApp(vault, publicDir);

  const stopWatch = vault.watch(() => {
    console.log("[brainz-web] vault changed — index updated (refresh the page)");
  });

  server.listen(port, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    console.log(`brainz-web serving vault ${dir}`);
    console.log(`Listening on http://localhost:${actualPort}`);
  });

  const shutdown = (): void => {
    stopWatch();
    server.close();
    vault.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(`brainz-web: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
