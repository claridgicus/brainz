import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliContextJsonSchema,
  cliRelatedJsonSchema,
  cliSearchJsonSchema,
  cliValidateJsonSchema,
} from "@brainz/contracts";
import type { z } from "zod";
import { runCli } from "../src/program.js";
import { resolvePackageDir } from "../src/spawn.js";

const DEMO_VAULT = fileURLToPath(new URL("../../../examples/demo-vault", import.meta.url));
const DIST_BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "brainz-cli-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Copy the demo vault (sans derived .brainz) into a fresh temp dir. */
async function copyDemoVault(): Promise<string> {
  const dir = await makeDir();
  await cp(DEMO_VAULT, dir, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes(".brainz"),
  });
  return dir;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], stdin = ""): Promise<RunResult> {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    readStdin: async () => stdin,
  });
  return { code, out, err };
}

/** Assert a --json payload parses with its @brainz/contracts schema (the anti-drift guarantee). */
function expectContract(schema: z.ZodTypeAny, value: unknown): void {
  const parsed = schema.safeParse(value);
  expect(
    parsed.success,
    `--json output does not match contract schema: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`,
  ).toBe(true);
}

describe("brainz init", () => {
  it("scaffolds config, concepts dir, sample note, and .gitignore", async () => {
    const dir = await makeDir();
    const res = await run(["init", dir]);
    expect(res.code).toBe(0);
    expect(existsSync(path.join(dir, "brainz.config.json"))).toBe(true);
    expect(existsSync(path.join(dir, "concepts", "welcome.md"))).toBe(true);
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(res.out).toContain("Next steps");
    const config = JSON.parse(await readFile(path.join(dir, "brainz.config.json"), "utf8"));
    expect(config.name).toBe(path.basename(dir));
  });

  it("skips existing files on re-run", async () => {
    const dir = await makeDir();
    await run(["init", dir]);
    await writeFile(path.join(dir, "brainz.config.json"), '{"name":"keep-me"}\n');
    const res = await run(["init", dir, "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out);
    expect(parsed.created).toEqual([]);
    expect(parsed.skipped).toContain("brainz.config.json");
    const config = JSON.parse(await readFile(path.join(dir, "brainz.config.json"), "utf8"));
    expect(config.name).toBe("keep-me");
  });
});

describe("brainz add / show", () => {
  it("round-trips a concept", async () => {
    const dir = await makeDir();
    await run(["init", dir]);
    const add = await run([
      "add",
      "Session Timeout",
      "--vault",
      dir,
      "--type",
      "decision",
      "--tags",
      "auth,session",
      "--product",
      "acme",
      "--body",
      "Sessions expire after 30 minutes of inactivity.",
    ]);
    expect(add.code).toBe(0);
    expect(add.out).toContain("session-timeout");

    const show = await run(["show", "session-timeout", "--vault", dir, "--json"]);
    expect(show.code).toBe(0);
    const concept = JSON.parse(show.out);
    expect(concept.id).toBe("session-timeout");
    expect(concept.type).toBe("decision");
    expect(concept.tags).toEqual(["auth", "session"]);
    expect(concept.product).toBe("acme");
    expect(concept.body).toContain("30 minutes");

    const human = await run(["show", "session-timeout", "--vault", dir]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Session Timeout");
    expect(human.out).toContain("30 minutes");
  });

  it("reads the body from stdin with --stdin", async () => {
    const dir = await makeDir();
    await run(["init", dir]);
    const res = await run(["add", "Piped Note", "--vault", dir, "--stdin"], "body from stdin\n");
    expect(res.code).toBe(0);
    const show = await run(["show", "piped-note", "--vault", dir, "--json"]);
    expect(JSON.parse(show.out).body).toContain("body from stdin");
  });

  it("exits 1 for an unknown id on show", async () => {
    const dir = await copyDemoVault();
    const res = await run(["show", "nope-not-here", "--vault", dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("unknown concept");
  });

  it("exits 1 when the directory is not a vault", async () => {
    const dir = await makeDir();
    const res = await run(["search", "auth", "--vault", dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("not a brainz vault");
  });
});

describe("brainz search", () => {
  it("returns hits as JSON with --json", async () => {
    const dir = await copyDemoVault();
    const res = await run(["search", "auth", "--vault", dir, "--json"]);
    expect(res.code).toBe(0);
    const hits = JSON.parse(res.out);
    expectContract(cliSearchJsonSchema, hits);
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    const ids = hits.map((h: { concept: { id: string } }) => h.concept.id);
    expect(ids).toContain("auth-system");
    expect(hits[0]).toHaveProperty("score");
    expect(hits[0]).toHaveProperty("snippet");
  });

  it("prints aligned human output and respects --limit", async () => {
    const dir = await copyDemoVault();
    const res = await run(["search", "contact", "--vault", dir, "--limit", "1"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("ID");
    expect(res.out).toContain("SNIPPET");
    // header + exactly one hit row
    expect(res.out.trim().split("\n")).toHaveLength(2);
  });
});

describe("brainz related", () => {
  it("lists depth-1 neighbors", async () => {
    const dir = await copyDemoVault();
    const res = await run(["related", "auth-system", "--vault", dir, "--json"]);
    expect(res.code).toBe(0);
    const nodes = JSON.parse(res.out);
    expectContract(cliRelatedJsonSchema, nodes);
    const ids = nodes.map((n: { concept: { id: string } }) => n.concept.id);
    expect(ids).toContain("use-jwt-sessions");
    for (const node of nodes) expect(node.distance).toBe(1);
  });

  it("expands with --depth", async () => {
    const dir = await copyDemoVault();
    const d1 = JSON.parse((await run(["related", "auth-system", "--vault", dir, "--json"])).out);
    const d2 = JSON.parse(
      (await run(["related", "auth-system", "--vault", dir, "--depth", "2", "--json"])).out,
    );
    expect(d2.length).toBeGreaterThan(d1.length);
    expect(d2.some((n: { distance: number }) => n.distance === 2)).toBe(true);
  });

  it("exits 1 for an unknown id", async () => {
    const dir = await copyDemoVault();
    const res = await run(["related", "ghost", "--vault", dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("unknown concept");
  });
});

describe("brainz link", () => {
  it("adds a typed edge and persists it to frontmatter", async () => {
    const dir = await copyDemoVault();
    const res = await run(["link", "lead", "mrr", "--relation", "related_to", "--vault", dir]);
    expect(res.code).toBe(0);
    const raw = await readFile(path.join(dir, "concepts", "lead.md"), "utf8");
    expect(raw).toContain("related_to");
    expect(raw).toContain("mrr");
    const related = JSON.parse((await run(["related", "mrr", "--vault", dir, "--json"])).out);
    const ids = related.map((n: { concept: { id: string } }) => n.concept.id);
    expect(ids).toContain("lead");
  });

  it("exits 1 when the source concept is unknown", async () => {
    const dir = await copyDemoVault();
    const res = await run(["link", "ghost", "lead", "--vault", dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("ghost");
  });
});

describe("brainz context", () => {
  it("prints bundle markdown to stdout and stats to stderr", async () => {
    const dir = await copyDemoVault();
    const res = await run(["context", "--query", "auth", "--vault", dir]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^## /);
    expect(res.out).toContain("(auth-system)");
    expect(res.err).toContain("concepts");
    expect(res.err).toContain("tokens");
  });

  it("respects --budget and reports truncation", async () => {
    const dir = await copyDemoVault();
    const full = JSON.parse(
      (await run(["context", "--query", "auth", "--vault", dir, "--json"])).out,
    );
    const tiny = JSON.parse(
      (await run(["context", "--query", "auth", "--vault", dir, "--budget", "60", "--json"])).out,
    );
    expect(full.included.length).toBeGreaterThan(tiny.included.length);
    expect(tiny.truncated).toBe(true);
    expect(tiny.approxTokens).toBeLessThanOrEqual(60);
  });

  it("accepts explicit --ids seeds", async () => {
    const dir = await copyDemoVault();
    const res = await run(["context", "--ids", "lead,mrr", "--vault", dir, "--json"]);
    expect(res.code).toBe(0);
    const bundle = JSON.parse(res.out);
    expectContract(cliContextJsonSchema, bundle);
    const ids = bundle.included.map((m: { id: string }) => m.id);
    expect(ids).toContain("lead");
    expect(ids).toContain("mrr");
  });

  it("exits 1 without --query or --ids", async () => {
    const dir = await copyDemoVault();
    const res = await run(["context", "--vault", dir]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("--query");
  });
});

describe("brainz reindex", () => {
  it("reports counts and embedding status", async () => {
    const dir = await copyDemoVault();
    const res = await run(["reindex", "--vault", dir, "--json"]);
    expect(res.code).toBe(0);
    const stats = JSON.parse(res.out);
    expect(stats.concepts).toBe(13);
    expect(stats.edges).toBeGreaterThan(0);
    expect(stats.embeddingStatus).toBe("unavailable"); // demo vault: provider "none"
    const human = await run(["reindex", "--vault", dir]);
    expect(human.out).toContain("embeddings: unavailable");
  });
});

describe("brainz validate", () => {
  it("exits 0 on the demo vault with exactly 2 broken-link warnings", async () => {
    const dir = await copyDemoVault();
    const res = await run(["validate", "--vault", dir, "--json"]);
    expect(res.code).toBe(0);
    const result = JSON.parse(res.out);
    expectContract(cliValidateJsonSchema, result);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    const text = result.warnings.map((w: { message: string }) => w.message).join("\n");
    expect(text).toContain("csv-parser");
    expect(text).toContain("use-mysql");
  });

  it("exits 1 on duplicate ids", async () => {
    const dir = await makeDir();
    await mkdir(path.join(dir, "concepts"), { recursive: true });
    await writeFile(
      path.join(dir, "brainz.config.json"),
      '{"name":"dupes","embedding":{"provider":"none"}}\n',
    );
    await writeFile(path.join(dir, "concepts", "a.md"), "---\nid: dup-x\ntitle: A\n---\n\nA body\n");
    await writeFile(path.join(dir, "concepts", "b.md"), "---\nid: dup-x\ntitle: B\n---\n\nB body\n");
    const res = await run(["validate", "--vault", dir, "--json"]);
    expect(res.code).toBe(1);
    const result = JSON.parse(res.out);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: { message: string }) => e.message.includes('duplicate id "dup-x"'))).toBe(
      true,
    );
  });

  it("exits 1 on unparseable frontmatter (which core silently skips)", async () => {
    const dir = await makeDir();
    await mkdir(path.join(dir, "concepts"), { recursive: true });
    await writeFile(
      path.join(dir, "brainz.config.json"),
      '{"name":"bad-fm","embedding":{"provider":"none"}}\n',
    );
    await writeFile(
      path.join(dir, "concepts", "broken.md"),
      "---\ntitle: [unclosed\nstatus active\n---\n\nbody\n",
    );
    const res = await run(["validate", "--vault", dir, "--json"]);
    expect(res.code).toBe(1);
    const result = JSON.parse(res.out);
    expect(
      result.errors.some((e: { message: string }) => e.message.includes("unparseable frontmatter")),
    ).toBe(true);
  });
});

describe("mcp/web runtime resolution", () => {
  it("resolvePackageDir returns null for a package that is not installed", () => {
    expect(resolvePackageDir("@brainz/definitely-not-a-real-package")).toBeNull();
  });

  it("resolvePackageDir finds an installed package without importing it", () => {
    const dir = resolvePackageDir("@brainz/core");
    expect(dir).not.toBeNull();
    expect(existsSync(path.join(dir!, "package.json"))).toBe(true);
  });
});

describe("dist smoke tests (child process)", () => {
  it("brainz search works from the built binary", async () => {
    const dir = await copyDemoVault();
    const res = spawnSync(
      process.execPath,
      [DIST_BIN, "search", "auth", "--vault", dir, "--json"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    const hits = JSON.parse(res.stdout);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("brainz context pipes markdown to stdout, stats to stderr", async () => {
    const dir = await copyDemoVault();
    const res = spawnSync(process.execPath, [DIST_BIN, "context", "--query", "auth", "--vault", dir], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^## /);
    expect(res.stderr).toContain("tokens");
  });

  it("exits 1 with a usage error for unknown commands", () => {
    const res = spawnSync(process.execPath, [DIST_BIN, "frobnicate"], { encoding: "utf8" });
    expect(res.status).toBe(1);
  });
});
