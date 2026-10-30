import { describe, expect, it } from "vitest";
import {
  fingerprint,
  gitBlobOid,
  globToRegExp,
  matchingBlobs,
  parseIndexListing,
  parseTreeListing,
  staleness,
  type Blob,
} from "../src/fingerprint.js";

const blobs: ReadonlyArray<Blob> = [
  { path: "apps/cloud/src/routes/oauth/authorize/+page.svelte", oid: "a1" },
  { path: "apps/cloud/src/routes/oauth/authorize/page.test.ts", oid: "a2" },
  { path: "apps/cloud/src/routes/oauth/authorize/+page.server.ts", oid: "a3" },
  { path: "apps/cloud/src/lib/components/Graph.svelte", oid: "b1" },
  { path: "apps/cloud/src/lib/components/Graph.test.ts", oid: "b2" },
  { path: "apps/cloud/src/app.css", oid: "c1" },
  { path: "demos/src/take.ts", oid: "d1" },
  { path: "demos/test/take.test.ts", oid: "d2" },
  { path: "packages/cli/src/bin.ts", oid: "e1" },
  { path: "README.md", oid: "f1" },
];

describe("globToRegExp", () => {
  it("spans directories with ** and a name with *", () => {
    const deep = globToRegExp("apps/cloud/src/routes/oauth/**");
    expect(deep.test("apps/cloud/src/routes/oauth/authorize/+page.svelte")).toBe(true);
    expect(deep.test("apps/cloud/src/routes/oauth/a/b/c.ts")).toBe(true);
    expect(deep.test("apps/cloud/src/lib/components/Graph.svelte")).toBe(false);
    const flat = globToRegExp("packages/*/src/bin.ts");
    expect(flat.test("packages/cli/src/bin.ts")).toBe(true);
    expect(flat.test("packages/a/b/src/bin.ts")).toBe(false);
    expect(globToRegExp("**/app.css").test("apps/cloud/src/app.css")).toBe(true);
    expect(globToRegExp("app.css").test("apps/cloud/src/app.css")).toBe(false);
    expect(globToRegExp("a?c.ts").test("abc.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("aXts")).toBe(false);
  });

  it("takes SvelteKit's (group) and [param] directories literally", () => {
    const route = globToRegExp("apps/cloud/src/routes/(app)/v/[slug]/+page.svelte");
    expect(route.test("apps/cloud/src/routes/(app)/v/[slug]/+page.svelte")).toBe(true);
    expect(route.test("apps/cloud/src/routes/app/v/s/+page.svelte")).toBe(false);
  });
});

describe("matchingBlobs", () => {
  it("keeps sources, drops tests, and sorts by path", () => {
    const matched = matchingBlobs(["apps/cloud/src/routes/oauth/**", "demos/**"], blobs);
    expect(matched.map((b) => b.path)).toEqual([
      "apps/cloud/src/routes/oauth/authorize/+page.server.ts",
      "apps/cloud/src/routes/oauth/authorize/+page.svelte",
      "demos/src/take.ts",
    ]);
  });
});

describe("fingerprint", () => {
  it("is stable, ignores order, and changes with any dependency's content", () => {
    const deps = ["apps/cloud/src/routes/oauth/**"];
    const a = fingerprint(deps, blobs);
    const shuffled = [...blobs].reverse();
    expect(fingerprint(deps, shuffled)).toBe(a);
    const edited = blobs.map((b) => (b.path.endsWith("+page.server.ts") ? { ...b, oid: "zz" } : b));
    expect(fingerprint(deps, edited)).not.toBe(a);
    // The dashboard's components are an implicit dependency of every demo; a test file is not.
    const shared = blobs.map((b) => (b.path.endsWith("Graph.svelte") ? { ...b, oid: "zz" } : b));
    expect(fingerprint(deps, shared)).not.toBe(a);
    const test = blobs.map((b) => (b.path.endsWith("Graph.test.ts") ? { ...b, oid: "zz" } : b));
    expect(fingerprint(deps, test)).toBe(a);
    // A file no demo shows is not part of any fingerprint.
    const unrelated = blobs.map((b) => (b.path === "packages/cli/src/bin.ts" || b.path === "README.md" ? { ...b, oid: "zz" } : b));
    expect(fingerprint(deps, unrelated)).toBe(a);
  });
});

describe("gitBlobOid", () => {
  it("matches git hash-object", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobOid(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("parseIndexListing", () => {
  it("reads `git ls-files -s` lines", () => {
    const listing = "100644 ce013625030ba8dba906f756967f9e9ca394464a 0\tREADME.md\n100755 abc 0\tbin/run\n\n";
    expect(parseIndexListing(listing)).toEqual([
      { path: "README.md", oid: "ce013625030ba8dba906f756967f9e9ca394464a" },
      { path: "bin/run", oid: "abc" },
    ]);
  });
});

describe("parseTreeListing", () => {
  it("reads `git ls-tree -r` lines, blobs only", () => {
    const listing = "100644 blob ce01\tREADME.md\n160000 commit dead\tvendor/lib\n100755 blob abc\tbin/run\n\n";
    expect(parseTreeListing(listing)).toEqual([
      { path: "README.md", oid: "ce01" },
      { path: "bin/run", oid: "abc" },
    ]);
  });
});

describe("staleness", () => {
  const recorded = { pipeline: { hash: "h1", recordedAt: "2026-09-03T00:00:00Z", seconds: 30 } };
  it("names why a clip is stale", () => {
    const outputs = ["static/demos/pipeline.mp4"];
    expect(staleness("pipeline", "h1", recorded, outputs, () => true)).toEqual({ kind: "fresh" });
    expect(staleness("pipeline", "h2", recorded, outputs, () => true)).toEqual({ kind: "changed" });
    expect(staleness("import", "h1", recorded, outputs, () => true)).toEqual({ kind: "unrecorded" });
    expect(staleness("pipeline", "h1", recorded, outputs, () => false)).toEqual({
      kind: "missing-output",
      file: "static/demos/pipeline.mp4",
    });
  });
});
