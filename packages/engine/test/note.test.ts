import { describe, expect, it } from "vitest";
import {
  extractWikiLinks,
  parseNote,
  readFrontmatter,
  serializeNote,
} from "../src/note.js";
import { slugify } from "../src/slugify.js";

describe("slugify", () => {
  it("lowercases and dashes non-alnum runs", () => {
    expect(slugify("Auth Session Model")).toBe("auth-session-model");
    expect(slugify("  Use PostgreSQL!! (v16) ")).toBe("use-postgresql-v16");
    expect(slugify("Café über GmbH")).toBe("cafe-uber-gmbh");
    expect(slugify("already-a-slug")).toBe("already-a-slug");
    expect(slugify("___")).toBe("");
  });
});

describe("parseNote", () => {
  it("parses full frontmatter", () => {
    const raw = [
      "---",
      "id: auth-session-model",
      "title: Auth Session Model",
      "type: decision",
      "product: acme-app",
      "tags: [auth, backend]",
      "status: draft",
      "createdAt: 2024-01-02",
      "relations:",
      "  depends_on: [jwt-tokens]",
      "  part_of: [auth-system]",
      "---",
      "",
      "Body text here.",
    ].join("\n");
    const { meta, body, relations } = parseNote(raw, { fallbackId: "auth-session-model" });
    expect(meta.id).toBe("auth-session-model");
    expect(meta.title).toBe("Auth Session Model");
    expect(meta.type).toBe("decision");
    expect(meta.status).toBe("draft");
    expect(meta.product).toBe("acme-app");
    expect(meta.tags).toEqual(["auth", "backend"]);
    expect(meta.createdAt).toBe("2024-01-02T00:00:00.000Z");
    expect(body).toBe("Body text here.");
    expect(relations).toEqual({ depends_on: ["jwt-tokens"], part_of: ["auth-system"] });
  });

  it("applies defaults: id from slugified fallback, title from id, type concept, status active", () => {
    const { meta } = parseNote("Just a body.", { fallbackId: "My Note" });
    expect(meta.id).toBe("my-note");
    expect(meta.title).toBe("my-note");
    expect(meta.type).toBe("concept");
    expect(meta.status).toBe("active");
    expect(meta.tags).toEqual([]);
    expect(meta.product).toBeUndefined();
  });

  it("coerces invalid type/status to defaults and scalar relations to arrays", () => {
    const raw = [
      "---",
      "type: banana",
      "status: gone",
      "relations:",
      "  depends_on: solo-target",
      "---",
      "x",
    ].join("\n");
    const { meta, relations } = parseNote(raw, { fallbackId: "n" });
    expect(meta.type).toBe("concept");
    expect(meta.status).toBe("active");
    expect(relations).toEqual({ depends_on: ["solo-target"] });
  });

  it("extracts wiki-links from the body (code excluded)", () => {
    const raw = [
      "---",
      "id: linker",
      "---",
      "",
      "See [[target-one]] and `[[not-a-link]]`, then [[target-two|label]].",
    ].join("\n");
    const { wikiLinks } = parseNote(raw, { fallbackId: "linker" });
    expect(wikiLinks).toEqual(["target-one", "target-two"]);
  });
});

describe("extractWikiLinks", () => {
  it("extracts [[id]] and [[id|label]] targets, deduped in order", () => {
    const links = extractWikiLinks(
      "See [[jwt-tokens]] and [[auth-system|the auth system]], then [[jwt-tokens]] again.",
    );
    expect(links).toEqual(["jwt-tokens", "auth-system"]);
  });

  it("ignores links inside fenced code blocks", () => {
    const body = [
      "Before [[real-link]].",
      "```md",
      "inside fence [[fenced-link]]",
      "```",
      "After [[another-real]].",
      "~~~",
      "[[tilde-fenced]]",
      "~~~",
    ].join("\n");
    expect(extractWikiLinks(body)).toEqual(["real-link", "another-real"]);
  });

  it("ignores links inside inline code spans", () => {
    const body = "Use `[[not-a-link]]` but do link [[yes-a-link]] and ``[[also-not]]``.";
    expect(extractWikiLinks(body)).toEqual(["yes-a-link"]);
  });

  it("returns empty for bodies without links", () => {
    expect(extractWikiLinks("no links here")).toEqual([]);
  });
});

describe("serializeNote / readFrontmatter", () => {
  it("round-trips a note through serialize -> parse", () => {
    const md = serializeNote(
      { id: "round-trip", title: "Round Trip", tags: ["a", "b"] },
      "Body with a [[link-target]].\n",
    );
    const { meta, body } = parseNote(md, { fallbackId: "x" });
    expect(meta.id).toBe("round-trip");
    expect(meta.title).toBe("Round Trip");
    expect(meta.tags).toEqual(["a", "b"]);
    expect(body.trim()).toBe("Body with a [[link-target]].");
  });

  it("preserves unknown frontmatter keys via the passthrough map", () => {
    const original = [
      "---",
      "id: keep",
      "title: Keeper",
      "custom_key: precious",
      "owner: team-auth",
      "---",
      "",
      "Old body.",
    ].join("\n");
    const { frontmatter, content } = readFrontmatter(original);
    frontmatter.title = "Keeper v2";
    const rewritten = serializeNote(frontmatter, content);
    const back = readFrontmatter(rewritten).frontmatter;
    expect(back.custom_key).toBe("precious");
    expect(back.owner).toBe("team-auth");
    expect(back.title).toBe("Keeper v2");
    expect(parseNote(rewritten, { fallbackId: "x" }).body.trim()).toBe("Old body.");
  });

  it("readFrontmatter preserves raw content for byte-identical rewrites", () => {
    const original = "---\nid: a\n---\n\nBody line.\n";
    const { frontmatter, content } = readFrontmatter(original);
    expect(content).toBe("\nBody line.\n");
    expect(serializeNote(frontmatter, content)).toBe(original);
  });
});
