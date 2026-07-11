import type {
  CliContextJson,
  CliReindexJson,
  CliRelatedJson,
  CliSearchJson,
  CliShowJson,
  CliShowNeighbor,
} from "@brainz/contracts";
import type { Concept, ConceptType } from "@brainz/core";
import { onboardingPlaybook, slugify, Vault } from "@brainz/core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import pc from "picocolors";
import { CliError } from "./errors.js";
import { resolvePackageBin, runBin } from "./spawn.js";
import { validateVault } from "./validate.js";

const CLI_VERSION = "0.1.0";
const CONCEPT_TYPES = [
  "concept",
  "domain",
  "feature",
  "story",
  "spec",
  "workflow",
  "task",
  "decision",
  "constraint",
  "pattern",
  "glossary",
];
const DEFAULT_WEB_PORT = 4680;

/** I/O seams so tests can drive the CLI in-process. Writers receive raw text. */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
}

/** Mutable per-invocation state threaded through command actions. */
export interface Ctx extends CliIO {
  exitCode: number;
}

// --------------------------------------------------------------------- utils

async function readProcessStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function flattenSnippet(text: string, maxLen = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

interface Globals {
  vaultDir: string;
  json: boolean;
}

function getGlobals(cmd: Command): Globals {
  const opts = cmd.optsWithGlobals<{ vault?: string; json?: boolean }>();
  return { vaultDir: path.resolve(opts.vault ?? process.cwd()), json: Boolean(opts.json) };
}

/** Allow `--vault`/`--json` both before and after the subcommand name. */
function withGlobals(cmd: Command): Command {
  return cmd
    .option("--vault <dir>", "vault directory (default: current directory)")
    .option("--json", "emit machine-readable JSON on stdout");
}

function requireVault(dir: string): void {
  if (
    fs.existsSync(path.join(dir, "brainz.config.json")) ||
    fs.existsSync(path.join(dir, "concepts"))
  ) {
    return;
  }
  throw new CliError(`not a brainz vault: ${dir} (run \`brainz init\` to create one)`);
}

async function withVault<T>(dir: string, fn: (vault: Vault) => Promise<T>): Promise<T> {
  requireVault(dir);
  const vault = await Vault.open(dir);
  try {
    return await fn(vault);
  } finally {
    vault.close();
  }
}

function printJson(ctx: Ctx, value: unknown): void {
  ctx.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Neighbor row for `show` — the contract's shape; `title: null` → pending concept. */
type NeighborInfo = CliShowNeighbor;

function neighborsOf(vault: Vault, id: string): NeighborInfo[] {
  const neighbors: NeighborInfo[] = [];
  for (const edge of vault.edges()) {
    if (edge.from === id) {
      neighbors.push({
        direction: "out",
        relation: edge.relation,
        id: edge.to,
        title: vault.getConcept(edge.to)?.title ?? null,
      });
    } else if (edge.to === id) {
      neighbors.push({
        direction: "in",
        relation: edge.relation,
        id: edge.from,
        title: vault.getConcept(edge.from)?.title ?? null,
      });
    }
  }
  return neighbors;
}

const SAMPLE_NOTE = `---
id: welcome
title: Welcome to Brainz
type: concept
tags: [meta]
status: active
---

This vault stores product knowledge as small, linked markdown concepts —
domains, features, stories, specs, workflows, decisions, constraints,
patterns, and glossary entries.

- Index an existing product with \`brainz onboard\` (prints the playbook an
  agent follows to map the codebase into concepts).
- Add concepts with \`brainz add "Title" --body "..."\` or by dropping \`.md\`
  files into \`concepts/\`.
- Link concepts with inline wiki-links (\`[[some-id]]\`) or typed
  \`relations:\` in frontmatter; \`code_areas:\` points at where the knowledge
  lives in the codebase.
- Retrieve knowledge with \`brainz search <query>\` or assemble an
  agent-ready bundle with \`brainz context --query <q>\`.
`;

// ------------------------------------------------------------------- program

export function buildProgram(ctx: Ctx): Command {
  const program = new Command();
  program
    .name("brainz")
    .description("Product knowledge vault for agent orchestration")
    .version(CLI_VERSION)
    .option("--vault <dir>", "vault directory", process.cwd())
    .option("--json", "emit machine-readable JSON on stdout", false)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => ctx.out(str),
      writeErr: (str) => ctx.err(str),
    });

  // ---- init ----------------------------------------------------------------
  withGlobals(
    program
      .command("init [dir]")
      .description("scaffold a new vault (config, concepts/, sample note)"),
  ).action(async (dirArg: string | undefined, _opts, cmd: Command) => {
    const g = getGlobals(cmd);
    const dir = dirArg ? path.resolve(dirArg) : g.vaultDir;
    const created: string[] = [];
    const skipped: string[] = [];

    await fsp.mkdir(path.join(dir, "concepts"), { recursive: true });
    const writeIfMissing = async (relPath: string, content: string): Promise<void> => {
      const full = path.join(dir, relPath);
      if (fs.existsSync(full)) {
        skipped.push(relPath);
        return;
      }
      await fsp.writeFile(full, content);
      created.push(relPath);
    };

    const config = { name: path.basename(dir), embedding: { provider: "cloudflare" } };
    await writeIfMissing("brainz.config.json", `${JSON.stringify(config, null, 2)}\n`);
    await writeIfMissing(path.join("concepts", "welcome.md"), SAMPLE_NOTE);
    await writeIfMissing(".gitignore", ".brainz/\n");

    if (g.json) {
      printJson(ctx, { dir, created, skipped });
      return;
    }
    ctx.out(`Initialized brainz vault in ${pc.bold(dir)}\n`);
    for (const f of created) ctx.out(`  ${pc.green("created")}  ${f}\n`);
    for (const f of skipped) ctx.out(`  ${pc.dim("skipped")}  ${f} (already exists)\n`);
    const inPlace = dir === process.cwd();
    const vaultFlag = inPlace ? "" : ` --vault ${dirArg ?? dir}`;
    ctx.out(
      [
        "",
        "Next steps:",
        ...(inPlace ? [] : [`  cd ${dirArg ?? dir}`]),
        `  brainz add "My First Concept" --body "..."${vaultFlag}`,
        `  brainz search welcome${vaultFlag}`,
        `  brainz context --query welcome${vaultFlag}`,
        `  brainz mcp${vaultFlag}    # expose the vault to agents over MCP`,
        "",
        "Semantic search uses Cloudflare Workers AI by default — set CLOUDFLARE_ACCOUNT_ID",
        "and CLOUDFLARE_API_TOKEN to enable it (without them, search is keyword-only).",
        "",
      ].join("\n"),
    );
  });

  // ---- add -----------------------------------------------------------------
  withGlobals(program.command("add <title>").description("create (or update) a concept note"))
    .addOption(new Option("--type <type>", "concept type").choices(CONCEPT_TYPES))
    .option("--product <product>", "product grouping key")
    .option("--tags <tags>", "comma-separated tags", parseList)
    .option(
      "--code-areas <paths>",
      "comma-separated codebase paths/globs this knowledge lives in",
      parseList,
    )
    .option("--body <markdown>", "note body (markdown)")
    .addOption(new Option("--stdin", "read note body from stdin").conflicts("body"))
    .action(
      async (
        title: string,
        opts: {
          type?: ConceptType;
          product?: string;
          tags?: string[];
          codeAreas?: string[];
          body?: string;
          stdin?: boolean;
        },
        cmd: Command,
      ) => {
        const g = getGlobals(cmd);
        await withVault(g.vaultDir, async (vault) => {
          const body = opts.stdin ? await ctx.readStdin() : (opts.body ?? "");
          const existed = vault.getConcept(slugify(title)) !== null;
          const saved: Concept = await vault.upsertConcept({
            title,
            body,
            type: opts.type,
            product: opts.product,
            tags: opts.tags,
            codeAreas: opts.codeAreas,
          });
          if (g.json) {
            printJson(ctx, saved);
            return;
          }
          const relPath = path.relative(process.cwd(), saved.filePath);
          ctx.out(
            `${pc.green("✓")} ${existed ? "updated" : "created"} ${pc.cyan(saved.id)} → ${relPath}\n`,
          );
        });
      },
    );

  // ---- search --------------------------------------------------------------
  withGlobals(program.command("search <query>").description("search concepts"))
    .addOption(
      new Option("--mode <mode>", "search mode").choices(["hybrid", "keyword", "semantic"]),
    )
    .option("--product <product>", "filter by product")
    .option("--limit <n>", "max results", parsePositiveInt, 10)
    .action(
      async (
        query: string,
        opts: { mode?: "hybrid" | "keyword" | "semantic"; product?: string; limit: number },
        cmd: Command,
      ) => {
        const g = getGlobals(cmd);
        await withVault(g.vaultDir, async (vault) => {
          const hits = await vault.search({
            query,
            mode: opts.mode,
            product: opts.product,
            limit: opts.limit,
          });
          if (g.json) {
            printJson(ctx, hits satisfies CliSearchJson);
            return;
          }
          if ((opts.mode ?? "hybrid") !== "keyword" && vault.embeddingStatus === "unavailable") {
            ctx.err(pc.dim("note: embeddings unavailable — results are keyword-only\n"));
          }
          if (hits.length === 0) {
            ctx.out("No results.\n");
            return;
          }
          const idW = Math.max(2, ...hits.map((h) => h.concept.id.length));
          const typeW = Math.max(4, ...hits.map((h) => h.concept.type.length));
          const scoreW = 6;
          ctx.out(
            pc.dim(`${pad("ID", idW)}  ${pad("TYPE", typeW)}  ${pad("SCORE", scoreW)}  SNIPPET\n`),
          );
          for (const hit of hits) {
            ctx.out(
              `${pc.cyan(pad(hit.concept.id, idW))}  ${pc.magenta(pad(hit.concept.type, typeW))}  ` +
                `${pad(hit.score.toFixed(3), scoreW)}  ${flattenSnippet(hit.snippet)}\n`,
            );
          }
        });
      },
    );

  // ---- show ----------------------------------------------------------------
  withGlobals(
    program.command("show <id>").description("show a concept: metadata, body, and neighbors"),
  ).action(async (id: string, _opts, cmd: Command) => {
    const g = getGlobals(cmd);
    await withVault(g.vaultDir, async (vault) => {
      const concept = vault.getConcept(id);
      if (!concept) throw new CliError(`unknown concept: ${id}`);
      const neighbors = neighborsOf(vault, id);
      if (g.json) {
        printJson(ctx, { ...concept, neighbors } satisfies CliShowJson);
        return;
      }
      ctx.out(`${pc.bold(concept.title)}  ${pc.dim(`(${concept.id})`)}\n`);
      const metaBits = [
        `type: ${concept.type}`,
        `status: ${concept.status}`,
        ...(concept.product ? [`product: ${concept.product}`] : []),
      ];
      ctx.out(`${pc.dim(metaBits.join("   "))}\n`);
      if (concept.tags.length > 0) ctx.out(`${pc.dim(`tags: ${concept.tags.join(", ")}`)}\n`);
      if (concept.codeAreas && concept.codeAreas.length > 0) {
        ctx.out(`${pc.dim(`code areas: ${concept.codeAreas.join(", ")}`)}\n`);
      }
      ctx.out(`${pc.dim(`file: ${concept.filePath}`)}\n`);
      ctx.out(`\n${concept.body.trim()}\n`);
      if (neighbors.length > 0) {
        ctx.out(`\n${pc.bold("neighbors:")}\n`);
        const relW = Math.max(...neighbors.map((n) => n.relation.length));
        const idW = Math.max(...neighbors.map((n) => n.id.length));
        for (const n of neighbors) {
          const arrow = n.direction === "out" ? "→" : "←";
          const title = n.title ?? pc.yellow("(pending)");
          ctx.out(`  ${arrow} ${pad(n.relation, relW)}  ${pc.cyan(pad(n.id, idW))}  ${title}\n`);
        }
      }
    });
  });

  // ---- related ---------------------------------------------------------------
  withGlobals(program.command("related <id>").description("list graph neighbors of a concept"))
    .option("--depth <n>", "traversal depth (1-3)", parsePositiveInt, 1)
    .action(async (id: string, opts: { depth: number }, cmd: Command) => {
      const g = getGlobals(cmd);
      await withVault(g.vaultDir, async (vault) => {
        if (!vault.getConcept(id)) throw new CliError(`unknown concept: ${id}`);
        const nodes = vault.related(id, { depth: opts.depth });
        if (g.json) {
          printJson(ctx, nodes satisfies CliRelatedJson);
          return;
        }
        if (nodes.length === 0) {
          ctx.out("No related concepts.\n");
          return;
        }
        const idW = Math.max(2, ...nodes.map((n) => n.concept.id.length));
        ctx.out(pc.dim(`${pad("DIST", 4)}  ${pad("ID", idW)}  VIA\n`));
        for (const node of nodes) {
          const via = node.via.map((e) => `${e.from} —${e.relation}→ ${e.to}`).join(", ");
          ctx.out(
            `${pad(String(node.distance), 4)}  ${pc.cyan(pad(node.concept.id, idW))}  ${pc.dim(via)}\n`,
          );
        }
      });
    });

  // ---- link ------------------------------------------------------------------
  withGlobals(
    program
      .command("link <from> <to>")
      .description("add a typed edge between two concepts (edits frontmatter of <from>)"),
  )
    .option("--relation <relation>", "edge relation", "related_to")
    .action(async (from: string, to: string, opts: { relation: string }, cmd: Command) => {
      const g = getGlobals(cmd);
      await withVault(g.vaultDir, async (vault) => {
        await vault.link(from, to, opts.relation); // throws on unknown `from`
        const pending = vault.getConcept(to) === null;
        if (g.json) {
          printJson(ctx, { ok: true, from, to, relation: opts.relation, pendingTarget: pending });
          return;
        }
        const note = pending ? pc.yellow(" (target does not exist yet — pending concept)") : "";
        ctx.out(
          `${pc.green("✓")} linked ${pc.cyan(from)} —${opts.relation}→ ${pc.cyan(to)}${note}\n`,
        );
      });
    });

  // ---- context ---------------------------------------------------------------
  withGlobals(
    program
      .command("context")
      .description(
        "assemble a context bundle (markdown to stdout — pipe it straight into a prompt)",
      ),
  )
    .option("--query <query>", "seed concepts via search")
    .option("--ids <ids>", "comma-separated seed concept ids", parseList)
    .option("--budget <tokens>", "approximate token budget", parsePositiveInt, 4000)
    .option("--product <product>", "restrict to a product")
    .option("--depth <n>", "graph expansion depth", parsePositiveInt, 1)
    .action(
      async (
        opts: { query?: string; ids?: string[]; budget: number; product?: string; depth: number },
        cmd: Command,
      ) => {
        const g = getGlobals(cmd);
        if (!opts.query && (!opts.ids || opts.ids.length === 0)) {
          throw new CliError("context requires --query <q> and/or --ids <a,b>");
        }
        await withVault(g.vaultDir, async (vault) => {
          const bundle = await vault.assembleContext({
            query: opts.query,
            ids: opts.ids,
            tokenBudget: opts.budget,
            product: opts.product,
            depth: opts.depth,
          });
          if (g.json) {
            printJson(ctx, bundle satisfies CliContextJson);
            return;
          }
          if (bundle.markdown.length > 0) {
            ctx.out(bundle.markdown.endsWith("\n") ? bundle.markdown : `${bundle.markdown}\n`);
          }
          ctx.err(
            pc.dim(
              `context: ${bundle.included.length} concepts · ~${bundle.approxTokens} tokens ` +
                `(budget ${opts.budget})${bundle.truncated ? " · truncated" : ""}\n`,
            ),
          );
        });
      },
    );

  // ---- reindex ---------------------------------------------------------------
  withGlobals(
    program.command("reindex").description("rebuild the index from the markdown files"),
  ).action(async (_opts, cmd: Command) => {
    const g = getGlobals(cmd);
    await withVault(g.vaultDir, async (vault) => {
      await vault.reindex();
      const stats = vault.stats();
      if (g.json) {
        printJson(ctx, { ...stats, embeddingStatus: vault.embeddingStatus } satisfies CliReindexJson);
        return;
      }
      ctx.out(`${pc.green("✓")} reindexed ${stats.concepts} concepts · ${stats.edges} edges\n`);
      const byType = Object.entries(stats.byType)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ");
      if (byType) ctx.out(pc.dim(`  by type: ${byType}\n`));
      if (stats.products.length > 0) {
        ctx.out(pc.dim(`  products: ${stats.products.join(", ")}\n`));
      }
      ctx.out(
        vault.embeddingStatus === "ready"
          ? pc.dim("  embeddings: ready (semantic + hybrid search available)\n")
          : pc.dim(
              "  embeddings: unavailable (keyword-only search; provider \"cloudflare\" needs " +
                "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)\n",
            ),
      );
    });
  });

  // ---- validate --------------------------------------------------------------
  withGlobals(
    program
      .command("validate")
      .description("check the vault: duplicate ids & bad frontmatter (errors), broken links (warnings)"),
  ).action(async (_opts, cmd: Command) => {
    const g = getGlobals(cmd);
    requireVault(g.vaultDir);
    const result = await validateVault(g.vaultDir);
    if (g.json) {
      printJson(ctx, result);
    } else {
      for (const issue of result.errors) {
        ctx.out(`${pc.red("error")}    ${issue.file ? `${issue.file}: ` : ""}${issue.message}\n`);
      }
      for (const issue of result.warnings) {
        ctx.out(`${pc.yellow("warning")}  ${issue.file ? `${issue.file}: ` : ""}${issue.message}\n`);
      }
      const summary = `${result.errors.length} error(s), ${result.warnings.length} warning(s) — ` +
        `${result.concepts} concepts, ${result.edges} edges`;
      ctx.out(result.ok ? `${pc.green("✓")} ${summary}\n` : `${pc.red("✖")} ${summary}\n`);
    }
    if (!result.ok) ctx.exitCode = 1;
  });

  // ---- onboard -----------------------------------------------------------
  withGlobals(
    program
      .command("onboard")
      .description(
        "print the onboarding playbook (index your product into this vault); " +
          "--status reports progress, --complete marks the vault onboarded",
      ),
  )
    .option("--status", "report onboarded state and concept counts")
    .addOption(
      new Option("--complete", "mark the vault onboarded (requires --summary)").conflicts("status"),
    )
    .option("--summary <text>", "with --complete: what was indexed, notable gaps")
    .option("--product-name <name>", "product name, echoed into the playbook")
    .option("--repo-hint <path>", "where the codebase lives, echoed into the playbook")
    .action(
      async (
        opts: {
          status?: boolean;
          complete?: boolean;
          summary?: string;
          productName?: string;
          repoHint?: string;
        },
        cmd: Command,
      ) => {
        const g = getGlobals(cmd);
        await withVault(g.vaultDir, async (vault) => {
          if (opts.complete) {
            if (!opts.summary?.trim()) {
              throw new CliError("--complete requires --summary \"<what was indexed>\"");
            }
            // Guard against the "onboarded but empty" dead state; surface
            // quality signals on success (mirrors the onboard MCP tool).
            const stats = vault.stats();
            if (stats.concepts === 0) {
              throw new CliError(
                "cannot complete onboarding: the vault has no concepts — index the product first",
              );
            }
            const conceptsLackingCodeAreas = vault
              .listConcepts()
              .filter((c) => !c.codeAreas || c.codeAreas.length === 0).length;
            const saved = await vault.completeOnboarding(opts.summary);
            if (g.json) {
              printJson(ctx, {
                ok: true,
                onboarded: true,
                summaryConceptId: saved.id,
                conceptCount: stats.concepts,
                conceptsLackingCodeAreas,
                hasDomainConcepts: (stats.byType.domain ?? 0) > 0,
                byType: stats.byType,
              });
              return;
            }
            ctx.out(
              `${pc.green("✓")} vault marked onboarded — summary stored as ${pc.cyan(saved.id)}\n`,
            );
            return;
          }
          if (opts.status) {
            const stats = vault.stats();
            const status = {
              onboarded: stats.onboarded,
              conceptCount: stats.concepts,
              byType: stats.byType,
            };
            if (g.json) {
              printJson(ctx, status);
              return;
            }
            ctx.out(
              status.onboarded
                ? `${pc.green("✓")} onboarded — ${status.conceptCount} concepts\n`
                : `${pc.yellow("○")} not onboarded — ${status.conceptCount} concepts so far\n`,
            );
            const byType = Object.entries(status.byType)
              .map(([t, n]) => `${t} ${n}`)
              .join(", ");
            if (byType) ctx.out(pc.dim(`  by type: ${byType}\n`));
            if (!status.onboarded) {
              ctx.out(pc.dim("  run `brainz onboard` for the playbook\n"));
            }
            return;
          }
          // Idempotent start: an already-onboarded vault must NOT get a fresh
          // playbook — re-running it risks blindly duplicating concepts.
          if (vault.onboardedAt != null) {
            const parsed = new Date(vault.onboardedAt);
            const date = Number.isNaN(parsed.getTime())
              ? vault.onboardedAt
              : parsed.toISOString().slice(0, 10);
            throw new CliError(
              `already onboarded on ${date} — re-running onboard risks duplicate concepts; ` +
                "use `brainz onboard --status`, or edit concepts directly, to update",
            );
          }
          const playbook = onboardingPlaybook({
            productName: opts.productName,
            repoHint: opts.repoHint,
            onboarded: false,
          });
          if (g.json) {
            printJson(ctx, { onboarded: false, playbook });
            return;
          }
          ctx.out(playbook.endsWith("\n") ? playbook : `${playbook}\n`);
        });
      },
    );

  // ---- mcp ---------------------------------------------------------------
  withGlobals(
    program.command("mcp").description("run the @brainz/mcp-server MCP stdio server for this vault"),
  ).action(async (_opts, cmd: Command) => {
    const g = getGlobals(cmd);
    requireVault(g.vaultDir);
    const bin = resolvePackageBin("@brainz/mcp-server");
    ctx.exitCode = await runBin(bin, ["--vault", g.vaultDir]);
  });

  // ---- web ---------------------------------------------------------------
  withGlobals(program.command("web").description("run the @brainz/web graph-view web app"))
    .option("--port <port>", "port to listen on", parsePositiveInt, DEFAULT_WEB_PORT)
    .action(async (opts: { port: number }, cmd: Command) => {
      const g = getGlobals(cmd);
      requireVault(g.vaultDir);
      const bin = resolvePackageBin("@brainz/web");
      ctx.exitCode = await runBin(bin, ["--vault", g.vaultDir, "--port", String(opts.port)]);
    });

  return program;
}

// ---------------------------------------------------------------------- main

/**
 * Run the CLI. `argv` excludes node and script (e.g. `["search", "auth"]`).
 * Returns the process exit code; never calls process.exit.
 */
export async function runCli(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const ctx: Ctx = {
    out: io.out ?? ((text) => void process.stdout.write(text)),
    err: io.err ?? ((text) => void process.stderr.write(text)),
    readStdin: io.readStdin ?? readProcessStdin,
    exitCode: 0,
  };
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      // help/version display exits 0; usage errors exit 1 (message already printed)
      return error.exitCode === 0 ? 0 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.err(`${pc.red(`error: ${message}`)}\n`);
    return 1;
  }
  return ctx.exitCode;
}
