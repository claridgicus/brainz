import { describe, expect, it } from "vitest";
import { extractWikiLinks, parseNote } from "../src/parse.js";
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
    const { concept, relations } = parseNote("/vault/concepts/auth-session-model.md", raw);
    expect(concept.id).toBe("auth-session-model");
    expect(concept.title).toBe("Auth Session Model");
    expect(concept.type).toBe("decision");
    expect(concept.status).toBe("draft");
    expect(concept.product).toBe("acme-app");
    expect(concept.tags).toEqual(["auth", "backend"]);
    expect(concept.createdAt).toBe("2024-01-02T00:00:00.000Z");
    expect(concept.body).toBe("Body text here.");
    expect(relations).toEqual({ depends_on: ["jwt-tokens"], part_of: ["auth-system"] });
  });

  it("applies defaults: id from filename, title from id, type concept, status active", () => {
    const { concept } = parseNote("/vault/concepts/My Note.md", "Just a body.");
    expect(concept.id).toBe("my-note");
    expect(concept.title).toBe("my-note");
    expect(concept.type).toBe("concept");
    expect(concept.status).toBe("active");
    expect(concept.tags).toEqual([]);
    expect(concept.product).toBeUndefined();
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
    const { concept, relations } = parseNote("/v/concepts/n.md", raw);
    expect(concept.type).toBe("concept");
    expect(concept.status).toBe("active");
    expect(relations).toEqual({ depends_on: ["solo-target"] });
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
