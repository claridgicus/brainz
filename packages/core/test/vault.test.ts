import Database from "better-sqlite3";
import matter from "gray-matter";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbedder, CLOUDFLARE_BATCH_SIZE } from "../src/embeddings.js";
import { Vault } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  // Tests must never see real credentials or make real network calls.
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "brainz-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Create a vault dir with provider "none" and the given concept files. */
async function makeVault(files: Record<string, string> = {}): Promise<Vault> {
  const dir = await makeDir();
  await writeFile(
    path.join(dir, "brainz.config.json"),
    JSON.stringify({ name: "test", embedding: { provider: "none" } }),
  );
  await mkdir(path.join(dir, "concepts"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const fp = path.join(dir, "concepts", name);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, content);
  }
  const vault = await Vault.open(dir);
  cleanups.push(async () => vault.close());
  return vault;
}

function note(fm: Record<string, unknown>, body: string): string {
  return matter.stringify(body, fm);
}

const GRAPH = {
  "a.md": note({ id: "a", title: "Alpha", type: "concept", tags: ["x"] }, "Alpha links [[b]]."),
  "b.md": note(
    { id: "b", title: "Beta", type: "feature", relations: { depends_on: ["c"] } },
    "Beta body about postgres databases.",
  ),
  "c.md": note({ id: "c", title: "Gamma", type: "decision", tags: ["x", "y"] }, "Gamma body."),
};

describe("Vault.open", () => {
  it("creates missing dirs and default config", async () => {
    const dir = await makeDir();
    const vault = await Vault.open(dir);
    cleanups.push(async () => vault.close());
    expect(vault.dir).toBe(path.resolve(dir));
    expect(existsSync(path.join(dir, "concepts"))).toBe(true);
    expect(existsSync(path.join(dir, ".brainz", "index.db"))).toBe(true);
    const config = JSON.parse(await readFile(path.join(dir, "brainz.config.json"), "utf8"));
    expect(config).toEqual({ name: path.basename(dir), embedding: { provider: "cloudflare" } });
  });

  it("indexes existing notes on open", async () => {
    const vault = await makeVault(GRAPH);
    expect(vault.stats().concepts).toBe(3);
    expect(vault.getConcept("a")?.title).toBe("Alpha");
  });
});

describe("reindex", () => {
  it("is idempotent", async () => {
    const vault = await makeVault(GRAPH);
    const before = vault.stats();
    await vault.reindex();
    await vault.reindex();
    expect(vault.stats()).toEqual(before);
    expect(vault.edges()).toEqual([
      { from: "a", to: "b", relation: "references" },
      { from: "b", to: "c", relation: "depends_on" },
    ]);
  });

  it("skips files whose content hash is unchanged", async () => {
    const vault = await makeVault(GRAPH);
    // Tamper with the indexed row via a second connection; an unchanged file
    // must be skipped, so the sentinel survives reindex. A changed file must
    // be re-read.
    const db = new Database(path.join(vault.dir, ".brainz", "index.db"));
    db.prepare("UPDATE concepts SET body = 'SENTINEL' WHERE id = 'a'").run();
    db.close();
    await vault.reindex();
    expect(vault.getConcept("a")?.body).toBe("SENTINEL");

    await writeFile(
      path.join(vault.dir, "concepts", "a.md"),
      note({ id: "a", title: "Alpha v2" }, "New body."),
    );
    await vault.reindex();
    expect(vault.getConcept("a")?.title).toBe("Alpha v2");
    expect(vault.getConcept("a")?.body.trim()).toBe("New body.");
  });

  it("removes concepts whose files were deleted", async () => {
    const vault = await makeVault(GRAPH);
    await rm(path.join(vault.dir, "concepts", "c.md"));
    await vault.reindex();
    expect(vault.getConcept("c")).toBeNull();
    expect(vault.stats().concepts).toBe(2);
    // edge b -> c remains (pending concept), but c is gone from results
    expect(vault.related("b").map((n) => n.concept.id)).toEqual(["a"]);
  });
});

describe("search", () => {
  it("finds keyword matches with bm25 and returns snippets", async () => {
    const vault = await makeVault(GRAPH);
    const hits = await vault.search({ query: "postgres databases", mode: "keyword" });
    expect(hits.length).toBe(1);
    expect(hits[0].concept.id).toBe("b");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet.toLowerCase()).toContain("postgres");
  });

  it("matches title and tags too", async () => {
    const vault = await makeVault(GRAPH);
    const byTitle = await vault.search({ query: "Gamma", mode: "keyword" });
    expect(byTitle[0]?.concept.id).toBe("c");
  });

  it("sanitizes hostile queries instead of passing them to MATCH", async () => {
    const vault = await makeVault(GRAPH);
    await expect(
      vault.search({ query: '"; DROP TABLE concepts; -- NEAR( * ', mode: "keyword" }),
    ).resolves.toBeInstanceOf(Array);
    await expect(vault.search({ query: "   ", mode: "keyword" })).resolves.toEqual([]);
    expect(vault.stats().concepts).toBe(3);
  });

  it("applies product/tags/type filters and limit", async () => {
    const vault = await makeVault({
      "p1.md": note(
        { id: "p1", title: "Widget One", product: "acme", tags: ["x"], type: "feature" },
        "widget body",
      ),
      "p2.md": note(
        { id: "p2", title: "Widget Two", product: "other", tags: ["y"], type: "concept" },
        "widget body",
      ),
    });
    const byProduct = await vault.search({ query: "widget", product: "acme" });
    expect(byProduct.map((h) => h.concept.id)).toEqual(["p1"]);
    const byType = await vault.search({ query: "widget", type: "concept" });
    expect(byType.map((h) => h.concept.id)).toEqual(["p2"]);
    const byTag = await vault.search({ query: "widget", tags: ["x"] });
    expect(byTag.map((h) => h.concept.id)).toEqual(["p1"]);
    const limited = await vault.search({ query: "widget", limit: 1 });
    expect(limited.length).toBe(1);
  });

  it("hybrid and semantic silently fall back to keyword when embeddings unavailable", async () => {
    const vault = await makeVault(GRAPH);
    expect(vault.embeddingStatus).toBe("unavailable"); // provider "none"
    const hybrid = await vault.search({ query: "postgres" });
    const semantic = await vault.search({ query: "postgres", mode: "semantic" });
    const keyword = await vault.search({ query: "postgres", mode: "keyword" });
    expect(hybrid.map((h) => h.concept.id)).toEqual(keyword.map((h) => h.concept.id));
    expect(semantic.map((h) => h.concept.id)).toEqual(keyword.map((h) => h.concept.id));
  });

  it("degrades to unavailable when the local provider cannot load", async () => {
    // @xenova/transformers is not installed here
    const dir = await makeDir();
    await writeFile(
      path.join(dir, "brainz.config.json"),
      JSON.stringify({ name: "local-test", embedding: { provider: "local" } }),
    );
    const vault = await Vault.open(dir);
    cleanups.push(async () => vault.close());
    await vault.upsertConcept({ title: "Solo", body: "solo body text" });
    const hits = await vault.search({ query: "solo" });
    expect(hits.map((h) => h.concept.id)).toEqual(["solo"]);
    expect(vault.embeddingStatus).toBe("unavailable");
  });
});

describe("cloudflare embeddings", () => {
  /** Vault dir with provider "cloudflare" and the GRAPH notes (not yet opened,
   * so tests can stub env/fetch first). */
  async function makeCloudflareDir(
    provider = "cloudflare",
    files: Record<string, string> = GRAPH,
  ): Promise<string> {
    const dir = await makeDir();
    await writeFile(
      path.join(dir, "brainz.config.json"),
      JSON.stringify({ name: "cf-test", embedding: { provider } }),
    );
    await mkdir(path.join(dir, "concepts"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, "concepts", name), content);
    }
    return dir;
  }

  function stubCreds(): void {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-123");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-456");
  }

  /** Deterministic fake embedding: dimensions keyed to marker words so tests can
   * steer semantic similarity. Last dim is a bias so no vector is all-zero. */
  function fakeVec(text: string): number[] {
    const t = text.toLowerCase();
    return [
      t.includes("postgres") || t.includes("storage") ? 1 : 0,
      t.includes("alpha") ? 1 : 0,
      t.includes("gamma") ? 1 : 0,
      0.1,
    ];
  }

  function okResponse(texts: string[]): Response {
    return new Response(
      JSON.stringify({
        success: true,
        result: { shape: [texts.length, 4], data: texts.map(fakeVec) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("embeds via Workers AI, stores vectors, and hybrid/semantic search uses them", async () => {
    stubCreds();
    const calls: { url: string; auth: string | undefined; texts: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text: string[] };
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), auth: headers.get("authorization") ?? undefined, texts: body.text });
        return okResponse(body.text);
      }),
    );

    const vault = await Vault.open(await makeCloudflareDir());
    cleanups.push(async () => vault.close());
    expect(vault.embeddingStatus).toBe("ready");
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-base-en-v1.5",
    );
    expect(calls[0].auth).toBe("Bearer tok-456");
    expect(calls[0].texts.length).toBe(3); // one batched request for all 3 notes

    // Vectors are stored per concept as packed float32 blobs.
    const db = new Database(path.join(vault.dir, ".brainz", "index.db"));
    const rows = db.prepare("SELECT id, vector FROM embeddings ORDER BY id").all() as {
      id: string;
      vector: Buffer;
    }[];
    db.close();
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].vector.length).toBe(4 * 4); // 4 dims × float32

    // "storage" appears in no note text, so keyword search finds nothing —
    // only the stored vectors can rank b (whose fake vector matches) on top.
    expect(await vault.search({ query: "storage", mode: "keyword" })).toEqual([]);
    const semantic = await vault.search({ query: "storage", mode: "semantic" });
    expect(semantic[0]?.concept.id).toBe("b");
    const hybrid = await vault.search({ query: "storage" });
    expect(hybrid[0]?.concept.id).toBe("b");
    expect(vault.embeddingStatus).toBe("ready");
  });

  it("missing credentials → unavailable, keyword fallback, and no network calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const vault = await Vault.open(await makeCloudflareDir());
    cleanups.push(async () => vault.close());
    expect(vault.embeddingStatus).toBe("unavailable");
    const hits = await vault.search({ query: "postgres" });
    expect(hits[0]?.concept.id).toBe("b"); // keyword fallback still works
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("API error (non-2xx) → reindex still succeeds and degrades to keyword-only", async () => {
    stubCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500, statusText: "Internal Server Error" })),
    );
    const vault = await Vault.open(await makeCloudflareDir()); // must not throw
    cleanups.push(async () => vault.close());
    expect(vault.stats().concepts).toBe(3);
    expect(vault.embeddingStatus).toBe("unavailable");
    const hits = await vault.search({ query: "postgres" });
    expect(hits[0]?.concept.id).toBe("b");
  });

  it("network failure (fetch rejects) → reindex still succeeds", async () => {
    stubCreds();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const vault = await Vault.open(await makeCloudflareDir());
    cleanups.push(async () => vault.close());
    expect(vault.stats().concepts).toBe(3);
    expect(vault.embeddingStatus).toBe("unavailable");
  });

  it('legacy "openai" provider → unavailable with a one-line warning, never a crash', async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const vault = await Vault.open(await makeCloudflareDir("openai"));
    cleanups.push(async () => vault.close());
    expect(vault.embeddingStatus).toBe("unavailable");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"cloudflare"'));
    await vault.reindex(); // still succeeds
    const hits = await vault.search({ query: "postgres" });
    expect(hits[0]?.concept.id).toBe("b");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`splits requests into batches of ${CLOUDFLARE_BATCH_SIZE} texts, preserving order`, async () => {
    stubCreds();
    const batchSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const { text } = JSON.parse(String(init?.body)) as { text: string[] };
        batchSizes.push(text.length);
        return new Response(
          JSON.stringify({
            success: true,
            result: { shape: [text.length, 2], data: text.map((t) => [Number(t.slice(5)), 1]) },
          }),
          { status: 200 },
        );
      }),
    );
    const embedder = await createEmbedder({ provider: "cloudflare" });
    expect(embedder).not.toBeNull();
    const texts = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const vectors = await embedder!.embed(texts);
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(vectors.length).toBe(250);
    expect(vectors[0][0]).toBe(0);
    expect(vectors[249][0]).toBe(249);
  });
});

describe("related", () => {
  const CHAIN = {
    "a.md": note({ id: "a", title: "A", relations: { depends_on: ["b"] } }, "A."),
    "b.md": note({ id: "b", title: "B", relations: { depends_on: ["c"] } }, "B."),
    "c.md": note({ id: "c", title: "C" }, "C links [[d]]."),
    "d.md": note({ id: "d", title: "D" }, "D."),
  };

  it("traverses to depth 1 by default, in both directions", async () => {
    const vault = await makeVault(CHAIN);
    expect(vault.related("b").map((n) => n.concept.id)).toEqual(["a", "c"]);
    // reverse direction: d is only reachable via an edge pointing *to* it
    expect(vault.related("d").map((n) => n.concept.id)).toEqual(["c"]);
  });

  it("respects depth (max 3) and reports distance and via path", async () => {
    const vault = await makeVault(CHAIN);
    const d2 = vault.related("a", { depth: 2 });
    expect(d2.map((n) => [n.concept.id, n.distance])).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
    const c = d2.find((n) => n.concept.id === "c")!;
    expect(c.via).toEqual([
      { from: "a", to: "b", relation: "depends_on" },
      { from: "b", to: "c", relation: "depends_on" },
    ]);
    const d9 = vault.related("a", { depth: 9 }); // clamped to 3
    expect(d9.map((n) => n.concept.id)).toEqual(["b", "c", "d"]);
    expect(d9.find((n) => n.concept.id === "d")!.distance).toBe(3);
  });

  it("filters by relation types and applies limit", async () => {
    const vault = await makeVault(CHAIN);
    const only = vault.related("c", { depth: 3, relations: ["references"] });
    expect(only.map((n) => n.concept.id)).toEqual(["d"]);
    expect(vault.related("a", { depth: 3, limit: 2 }).length).toBe(2);
  });

  it("returns [] for unknown ids and excludes broken-link targets", async () => {
    const vault = await makeVault({
      "a.md": note({ id: "a", title: "A" }, "Links to [[ghost]]."),
    });
    expect(vault.related("nope")).toEqual([]);
    expect(vault.related("a")).toEqual([]); // ghost has no note
    expect(vault.edges()).toEqual([{ from: "a", to: "ghost", relation: "references" }]);
  });
});

describe("assembleContext", () => {
  it("seeds from ids and expands neighbors to depth", async () => {
    const vault = await makeVault(GRAPH);
    const bundle = await vault.assembleContext({ ids: ["a"], depth: 1 });
    expect(bundle.included.map((m) => m.id)).toEqual(["a", "b"]);
    expect(bundle.markdown).toContain("## Alpha (a)");
    expect(bundle.markdown).toContain("## Beta (b)");
    expect(bundle.truncated).toBe(false);
    expect(bundle.approxTokens).toBe(Math.ceil(bundle.markdown.length / 4));
  });

  it("seeds from query", async () => {
    const vault = await makeVault(GRAPH);
    const bundle = await vault.assembleContext({ query: "postgres", depth: 0 });
    expect(bundle.included.map((m) => m.id)).toEqual(["b"]);
  });

  it("requires query or ids", async () => {
    const vault = await makeVault(GRAPH);
    await expect(vault.assembleContext({})).rejects.toThrow(/query.*ids|ids.*query/i);
  });

  it("stops before exceeding the token budget and sets truncated", async () => {
    const big = "lorem ipsum dolor ".repeat(300); // ~5400 chars ≈ 1350 tokens
    const vault = await makeVault({
      "s1.md": note({ id: "s1", title: "Seed One" }, `${big} [[s2]]`),
      "s2.md": note({ id: "s2", title: "Seed Two" }, big),
    });
    const all = await vault.assembleContext({ ids: ["s1", "s2"] });
    expect(all.truncated).toBe(false);
    expect(all.included.length).toBe(2);

    const cut = await vault.assembleContext({ ids: ["s1", "s2"], tokenBudget: 1500 });
    expect(cut.truncated).toBe(true);
    expect(cut.included.map((m) => m.id)).toEqual(["s1"]);
    expect(cut.approxTokens).toBeLessThanOrEqual(1500);
  });

  it("filters expansion by product", async () => {
    const vault = await makeVault({
      "x.md": note({ id: "x", title: "X", product: "p" }, "Links [[y]] and [[z]]."),
      "y.md": note({ id: "y", title: "Y", product: "p" }, "Y."),
      "z.md": note({ id: "z", title: "Z", product: "other" }, "Z."),
    });
    const bundle = await vault.assembleContext({ ids: ["x"], product: "p" });
    expect(bundle.included.map((m) => m.id)).toEqual(["x", "y"]);
  });
});

describe("upsertConcept", () => {
  it("creates a new note, slugifying the id from the title", async () => {
    const vault = await makeVault();
    const saved = await vault.upsertConcept({
      title: "Rate Limiting Policy",
      body: "Throttle everything.",
      type: "constraint",
      tags: ["reliability"],
      product: "acme",
      relations: { constrains: ["api"] },
    });
    expect(saved.id).toBe("rate-limiting-policy");
    expect(saved.type).toBe("constraint");
    expect(saved.filePath).toBe(
      path.join(vault.dir, "concepts", "rate-limiting-policy.md"),
    );
    expect(existsSync(saved.filePath)).toBe(true);
    expect(vault.getConcept("rate-limiting-policy")?.body.trim()).toBe("Throttle everything.");
    expect(vault.edges()).toContainEqual({
      from: "rate-limiting-policy",
      to: "api",
      relation: "constrains",
    });
  });

  it("round-trips: written file parses back identically", async () => {
    const vault = await makeVault();
    await vault.upsertConcept({
      id: "round-trip",
      title: "Round Trip",
      body: "Body with a [[link-target]].",
      tags: ["a", "b"],
    });
    await vault.reindex();
    const again = vault.getConcept("round-trip")!;
    expect(again.title).toBe("Round Trip");
    expect(again.tags).toEqual(["a", "b"]);
    expect(again.body.trim()).toBe("Body with a [[link-target]].");
  });

  it("round-trips codeAreas as frontmatter code_areas (preserved when omitted)", async () => {
    const vault = await makeVault();
    const saved = await vault.upsertConcept({
      title: "Session Refresh",
      body: "Rotates tokens.",
      type: "feature",
      codeAreas: ["src/auth/session.ts", "apps/web/src/routes/**"],
    });
    expect(saved.codeAreas).toEqual(["src/auth/session.ts", "apps/web/src/routes/**"]);
    const fm = matter(await readFile(saved.filePath, "utf8")).data;
    expect(fm.code_areas).toEqual(["src/auth/session.ts", "apps/web/src/routes/**"]);

    // Survives a full reindex (db round-trip).
    await vault.reindex();
    expect(vault.getConcept("session-refresh")?.codeAreas).toEqual([
      "src/auth/session.ts",
      "apps/web/src/routes/**",
    ]);

    // Update WITHOUT codeAreas: frontmatter (and meta) keep the old value.
    const updated = await vault.upsertConcept({
      id: "session-refresh",
      title: "Session Refresh",
      body: "Rotates tokens more often.",
    });
    expect(updated.codeAreas).toEqual(["src/auth/session.ts", "apps/web/src/routes/**"]);

    // The context bundle carries the Code areas line.
    const bundle = await vault.assembleContext({ ids: ["session-refresh"], depth: 0 });
    expect(bundle.markdown).toContain(
      "Code areas: `src/auth/session.ts`, `apps/web/src/routes/**`",
    );
  });

  it("accepts the new ontology types", async () => {
    const vault = await makeVault();
    for (const type of ["domain", "story", "spec", "workflow"] as const) {
      const saved = await vault.upsertConcept({ title: `A ${type}`, body: "x", type });
      expect(saved.type).toBe(type);
    }
    expect(vault.listConcepts({ type: "domain" })).toHaveLength(1);
  });

  it("updates an existing note, preserving unknown frontmatter keys", async () => {
    const vault = await makeVault({
      "keep.md": [
        "---",
        "id: keep",
        "title: Keeper",
        "custom_key: precious",
        "owner: team-auth",
        "tags: [old]",
        "---",
        "",
        "Old body.",
      ].join("\n"),
    });
    const saved = await vault.upsertConcept({
      id: "keep",
      title: "Keeper v2",
      body: "New body.",
      tags: ["new"],
    });
    expect(saved.title).toBe("Keeper v2");
    const raw = await readFile(saved.filePath, "utf8");
    const fm = matter(raw).data;
    expect(fm.custom_key).toBe("precious");
    expect(fm.owner).toBe("team-auth");
    expect(fm.tags).toEqual(["new"]);
    expect(vault.getConcept("keep")?.body.trim()).toBe("New body.");
  });
});

describe("link", () => {
  it("adds a typed relation to the source frontmatter and reindexes", async () => {
    const vault = await makeVault(GRAPH);
    await vault.link("c", "a", "supersedes");
    expect(vault.edges()).toContainEqual({ from: "c", to: "a", relation: "supersedes" });
    const raw = await readFile(path.join(vault.dir, "concepts", "c.md"), "utf8");
    expect(matter(raw).data.relations).toEqual({ supersedes: ["a"] });
    expect(vault.related("c").map((n) => n.concept.id)).toContain("a");
  });

  it("defaults to related_to, dedupes, and rejects unknown sources", async () => {
    const vault = await makeVault(GRAPH);
    await vault.link("a", "c");
    await vault.link("a", "c");
    const raw = await readFile(path.join(vault.dir, "concepts", "a.md"), "utf8");
    expect(matter(raw).data.relations).toEqual({ related_to: ["c"] });
    await expect(vault.link("ghost", "a")).rejects.toThrow(/ghost/);
  });
});

describe("listConcepts / stats", () => {
  it("lists with filters, ordered by id", async () => {
    const vault = await makeVault(GRAPH);
    expect(vault.listConcepts().map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(vault.listConcepts({ type: "feature" }).map((m) => m.id)).toEqual(["b"]);
    expect(vault.listConcepts({ tag: "x" }).map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("computes stats", async () => {
    const vault = await makeVault(GRAPH);
    const stats = vault.stats();
    expect(stats.concepts).toBe(3);
    expect(stats.edges).toBe(2);
    expect(stats.tags).toEqual(["x", "y"]);
    expect(stats.byType).toEqual({ concept: 1, feature: 1, decision: 1 });
    expect(stats.onboarded).toBe(false);
  });
});

describe("onboarding state", () => {
  it("persists onboardedAt in brainz.config.json and reloads it", async () => {
    const vault = await makeVault(GRAPH);
    expect(vault.onboardedAt).toBeNull();

    await vault.setOnboardedAt("2026-07-10T00:00:00.000Z");
    expect(vault.onboardedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(vault.stats().onboarded).toBe(true);

    const config = JSON.parse(
      await readFile(path.join(vault.dir, "brainz.config.json"), "utf8"),
    );
    expect(config.onboardedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(config.name).toBe("test"); // other config keys untouched

    // A fresh open sees the persisted state; clearing removes the key.
    const reopened = await Vault.open(vault.dir);
    cleanups.push(async () => reopened.close());
    expect(reopened.onboardedAt).toBe("2026-07-10T00:00:00.000Z");
    await reopened.setOnboardedAt(null);
    expect(reopened.onboardedAt).toBeNull();
    const cleared = JSON.parse(
      await readFile(path.join(vault.dir, "brainz.config.json"), "utf8"),
    );
    expect("onboardedAt" in cleared).toBe(false);
  });

  it("completeOnboarding stores the spec summary concept and marks onboarded", async () => {
    const vault = await makeVault(GRAPH);
    const saved = await vault.completeOnboarding("Indexed 3 concepts across 1 domain.");
    expect(saved.id).toBe("product-onboarding-summary");
    expect(saved.type).toBe("spec");
    expect(saved.body).toContain("Indexed 3 concepts");
    expect(vault.onboardedAt).not.toBeNull();
    expect(vault.stats().onboarded).toBe(true);
    await expect(vault.completeOnboarding("   ")).rejects.toThrow(/summary/);
  });
});

describe("demo vault", () => {
  it("indexes the shipped example vault", async () => {
    // Copy the demo vault so its .brainz stays clean of test artifacts.
    const src = path.resolve(import.meta.dirname, "../../../examples/demo-vault");
    const dir = await makeDir();
    const { cp } = await import("node:fs/promises");
    await cp(src, dir, { recursive: true });
    await rm(path.join(dir, ".brainz"), { recursive: true, force: true });
    const vault = await Vault.open(dir);
    cleanups.push(async () => vault.close());

    const stats = vault.stats();
    expect(stats.concepts).toBe(13);
    expect(stats.products).toEqual(["acme-crm"]);
    expect(Object.keys(stats.byType).sort()).toEqual([
      "concept",
      "constraint",
      "decision",
      "feature",
      "glossary",
      "pattern",
    ]);
    // broken links exist as edges but not as concepts
    const edges = vault.edges();
    expect(edges).toContainEqual({ from: "contact-import", to: "csv-parser", relation: "references" });
    expect(edges).toContainEqual({ from: "use-postgres", to: "use-mysql", relation: "supersedes" });
    expect(vault.getConcept("csv-parser")).toBeNull();
    // code spans / fences must not create edges
    expect(edges.find((e) => e.to === "this-is-code-not-a-link")).toBeUndefined();
    expect(edges.find((e) => e.to === "not-a-real-link")).toBeUndefined();

    const hits = await vault.search({ query: "gdpr residency", mode: "keyword" });
    expect(hits[0]?.concept.id).toBe("gdpr-data-residency");

    const bundle = await vault.assembleContext({ query: "email campaigns", depth: 1 });
    expect(bundle.included.length).toBeGreaterThan(1);
    expect(bundle.markdown).toContain("## Email Campaigns (email-campaigns)");
  });
});
