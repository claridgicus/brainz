import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { ConceptType, SearchOptions, Vault } from "@brainz/core";
import { buildGraph } from "./graph.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const MODES = new Set(["hybrid", "keyword", "semantic"]);
const TYPES = new Set(["concept", "feature", "decision", "constraint", "pattern", "glossary"]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Vault name from brainz.config.json, falling back to the directory name. */
function vaultName(dir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, "brainz.config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { name?: unknown }).name === "string"
    ) {
      return (parsed as { name: string }).name;
    }
  } catch {
    /* fall through */
  }
  return path.basename(path.resolve(dir));
}

function handleApi(vault: Vault, pathname: string, url: URL, res: http.ServerResponse): void {
  if (pathname === "/api/graph") {
    sendJson(res, 200, buildGraph(vault.listConcepts(), vault.edges()));
    return;
  }

  if (pathname.startsWith("/api/concept/")) {
    const id = decodeURIComponent(pathname.slice("/api/concept/".length));
    const concept = vault.getConcept(id);
    if (!concept) {
      sendJson(res, 404, { error: `Unknown concept: ${id}` });
      return;
    }
    const all = vault.edges();
    sendJson(res, 200, {
      ...concept,
      neighbors: vault.related(id, { depth: 1 }).map((r) => ({
        id: r.concept.id,
        title: r.concept.title,
        type: r.concept.type,
        distance: r.distance,
      })),
      edges: {
        outgoing: all.filter((e) => e.from === id),
        incoming: all.filter((e) => e.to === id),
      },
    });
    return;
  }

  if (pathname === "/api/search") {
    const q = url.searchParams.get("q");
    if (!q || !q.trim()) {
      sendJson(res, 400, { error: "Missing required query parameter: q" });
      return;
    }
    const opts: SearchOptions = { query: q };
    const mode = url.searchParams.get("mode");
    if (mode) {
      if (!MODES.has(mode)) {
        sendJson(res, 400, { error: `Invalid mode: ${mode}` });
        return;
      }
      opts.mode = mode as SearchOptions["mode"];
    }
    const type = url.searchParams.get("type");
    if (type) {
      if (!TYPES.has(type)) {
        sendJson(res, 400, { error: `Invalid type: ${type}` });
        return;
      }
      opts.type = type as ConceptType;
    }
    const product = url.searchParams.get("product");
    if (product) opts.product = product;
    const limit = url.searchParams.get("limit");
    if (limit) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        sendJson(res, 400, { error: `Invalid limit: ${limit}` });
        return;
      }
      opts.limit = n;
    }
    vault
      .search(opts)
      .then((hits) => sendJson(res, 200, { hits }))
      .catch((err: unknown) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    return;
  }

  if (pathname === "/api/stats") {
    sendJson(res, 200, {
      name: vaultName(vault.dir),
      dir: vault.dir,
      ...vault.stats(),
      embeddingStatus: vault.embeddingStatus,
    });
    return;
  }

  sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
}

function serveStatic(publicDir: string, pathname: string, res: http.ServerResponse): void {
  const indexPath = path.join(publicDir, "index.html");
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  const resolved = path.resolve(publicDir, rel);
  // Path-traversal guard + SPA fallback for anything that isn't a real file.
  const inRoot = resolved === publicDir || resolved.startsWith(publicDir + path.sep);
  const filePath =
    inRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : indexPath;
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found (frontend not built?)" });
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

/** Create (but don't start) the HTTP server for a vault. */
export function createApp(vault: Vault, publicDir: string): http.Server {
  const root = path.resolve(publicDir);
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: `Method not allowed: ${req.method ?? "?"}` });
        return;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        handleApi(vault, pathname, url, res);
      } else {
        serveStatic(root, pathname, res);
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
