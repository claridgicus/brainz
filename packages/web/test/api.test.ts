import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "@brainz/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { GraphPayload } from "../src/graph.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const demoVault = path.resolve(here, "../../../examples/demo-vault");
const publicDir = path.resolve(here, "../dist/public");

let vault: Vault;
let tmpDir: string;
let baseUrl: string;
let server: ReturnType<typeof createApp>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brainz-web-test-"));
  fs.cpSync(demoVault, tmpDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.brainz`),
  });
  vault = await Vault.open(tmpDir);
  server = createApp(vault, publicDir);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  vault.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/graph", () => {
  it("returns all concepts, edges, and pending nodes", async () => {
    const res = await fetch(`${baseUrl}/api/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphPayload;

    const real = body.nodes.filter((n) => !n.pending);
    const pending = body.nodes.filter((n) => n.pending);
    expect(real).toHaveLength(13);
    expect(body.edges).toHaveLength(54);

    // Pending nodes are exactly the edge endpoints with no concept file.
    const realIds = new Set(real.map((n) => n.id));
    const expectedPending = new Set(
      body.edges.flatMap((e) => [e.from, e.to]).filter((id) => !realIds.has(id)),
    );
    expect(new Set(pending.map((n) => n.id))).toEqual(expectedPending);
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) {
      expect(p.type).toBe("pending");
      expect(p.pending).toBe(true);
      expect(p.degree).toBeGreaterThan(0);
    }

    // Every node has the documented shape.
    for (const n of body.nodes) {
      expect(typeof n.id).toBe("string");
      expect(typeof n.title).toBe("string");
      expect(Array.isArray(n.tags)).toBe(true);
      expect(typeof n.degree).toBe("number");
    }

    // Degree is consistent with the edge list.
    const lead = body.nodes.find((n) => n.id === "lead");
    const leadEdges = body.edges.filter((e) => e.from === "lead" || e.to === "lead");
    expect(lead?.degree).toBe(leadEdges.length);
  });
});

describe("GET /api/concept/:id", () => {
  it("returns the full concept with body, neighbors, and edges", async () => {
    const res = await fetch(`${baseUrl}/api/concept/lead`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      title: string;
      body: string;
      neighbors: { id: string; distance: number }[];
      edges: { incoming: unknown[]; outgoing: unknown[] };
    };
    expect(body.id).toBe("lead");
    expect(body.body.length).toBeGreaterThan(0);
    expect(body.neighbors.length).toBeGreaterThan(0);
    expect(body.neighbors.every((n) => n.distance === 1)).toBe(true);
    expect(body.edges.incoming.length + body.edges.outgoing.length).toBeGreaterThan(0);
  });

  it("404s with a JSON error for unknown ids", async () => {
    const res = await fetch(`${baseUrl}/api/concept/no-such-thing`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no-such-thing");
  });
});

describe("GET /api/search", () => {
  it("returns hits for a query", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=lead+scoring`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { concept: { id: string }; snippet: string }[] };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.map((h) => h.concept.id)).toContain("lead-scoring");
  });

  it("supports mode=keyword", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=jwt&mode=keyword`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it("400s when q is missing or mode is invalid", async () => {
    const noQ = await fetch(`${baseUrl}/api/search`);
    expect(noQ.status).toBe(400);
    expect(((await noQ.json()) as { error: string }).error).toBeTruthy();

    const badMode = await fetch(`${baseUrl}/api/search?q=x&mode=psychic`);
    expect(badMode.status).toBe(400);
  });
});

describe("GET /api/stats", () => {
  it("returns vault stats plus name and embeddingStatus", async () => {
    const res = await fetch(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      concepts: number;
      edges: number;
      byType: Record<string, number>;
      products: string[];
      tags: string[];
      embeddingStatus: string;
    };
    expect(body.name).toBe("acme-crm");
    expect(body.concepts).toBe(13);
    expect(body.edges).toBe(54);
    expect(Object.values(body.byType).reduce((a, b) => a + b, 0)).toBe(13);
    expect(body.embeddingStatus).toBe("unavailable");
  });
});

describe("static serving", () => {
  it("serves index.html at / and falls back for SPA routes", async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    const html = await root.text();
    expect(html).toContain("<svg id=\"graph\"");

    const spa = await fetch(`${baseUrl}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe(html);
  });

  it("serves the bundled app.js with no external URLs", async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.length).toBeGreaterThan(1000);
    expect(js).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr|esm\.sh|cdnjs)/i);
  });

  it("does not escape the public dir", async () => {
    const res = await fetch(`${baseUrl}/..%2f..%2fpackage.json`);
    expect(res.status).toBe(200);
    // Traversal collapses to the SPA fallback, never the real package.json.
    expect(await res.text()).toContain("<svg id=\"graph\"");
  });

  it("returns 404 JSON for unknown API routes and 405 for POST", async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    const post = await fetch(`${baseUrl}/api/graph`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
