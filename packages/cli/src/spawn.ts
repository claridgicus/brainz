import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

/**
 * Locate an installed package's directory WITHOUT importing it, so sibling
 * workspace packages (@brainz/mcp-server, @brainz/web) can be resolved at
 * runtime regardless of build order.
 *
 * Tries `require.resolve("<pkg>/package.json")` first, then falls back to
 * walking node_modules upward (in case the package's `exports` map hides
 * `./package.json`).
 */
export function resolvePackageDir(pkgName: string): string | null {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve(`${pkgName}/package.json`));
  } catch {
    // exports map may not expose ./package.json — fall through to manual walk
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...pkgName.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the executable script declared in `bin` of the given package. */
export function resolvePackageBin(pkgName: string): string {
  const pkgDir = resolvePackageDir(pkgName);
  if (!pkgDir) {
    throw new CliError(
      `${pkgName} is not installed. It ships with the brainz workspace — run \`npm install\` ` +
        `(and \`npm run build\`) at the repo root, or \`npm install ${pkgName}\` in your project.`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin && typeof pkg.bin === "object"
        ? Object.values(pkg.bin)[0]
        : undefined;
  if (!rel) throw new CliError(`${pkgName} does not declare a binary in its package.json`);
  const binPath = path.resolve(pkgDir, rel);
  if (!fs.existsSync(binPath)) {
    throw new CliError(
      `${pkgName} is installed but its binary is missing (${binPath}). ` +
        `Build it first: npm run build (at the repo root).`,
    );
  }
  return binPath;
}

/** Spawn `node <binPath> ...args` inheriting stdio; resolves with the exit code. */
export function runBin(binPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
