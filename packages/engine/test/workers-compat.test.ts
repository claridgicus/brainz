import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: @brainz/engine must stay runnable on Cloudflare Workers. Its built
 * output must never import node builtins (node:fs, node:crypto, …) or
 * node-only packages (better-sqlite3, chokidar). The `test` script runs
 * `tsc -b` first, so dist/ always exists here.
 */
describe("workers compatibility", () => {
  const distDir = join(import.meta.dirname, "../dist");

  const jsFiles = readdirSync(distDir).filter((f) => f.endsWith(".js"));

  it("built output exists", () => {
    expect(jsFiles.length).toBeGreaterThan(0);
    expect(jsFiles).toContain("index.js");
  });

  const forbidden: [string, RegExp][] = [
    ["node: builtin import", /(?:from\s*|import\s*|require\s*\(\s*)["']node:/],
    ["bare node builtin import", /(?:from\s*|import\s*|require\s*\(\s*)["'](?:fs|path|crypto|os|child_process|stream|util|url|events|buffer)["']/],
    ["better-sqlite3", /better-sqlite3/],
    ["chokidar", /chokidar/],
  ];

  for (const [label, pattern] of forbidden) {
    it(`dist contains no ${label}`, () => {
      for (const file of jsFiles) {
        const content = readFileSync(join(distDir, file), "utf8");
        const match = content.match(pattern);
        expect(
          match,
          `${file} matches forbidden pattern ${pattern}: ${match?.[0] ?? ""}`,
        ).toBeNull();
      }
    });
  }
});
