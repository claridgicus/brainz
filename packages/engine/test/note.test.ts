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

  it("parses all 10 ontology types", () => {
    for (const type of [
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
    ]) {
      const { meta } = parseNote(`---\ntype: ${type}\n---\nx`, { fallbackId: "t" });
      expect(meta.type).toBe(type);
    }
  });

  it("reads task frontmatter (task_status/taken_by/taken_at/done_at)", () => {
    const raw = [
      "---",
      "id: task-fix-auth",
      "type: task",
      "task_status: taken",
      "taken_by: fleet-1",
      "taken_at: 2026-07-11T00:00:00.000Z",
      "---",
      "Fix the auth bug.",
    ].join("\n");
    const { meta } = parseNote(raw, { fallbackId: "task-fix-auth" });
    expect(meta.type).toBe("task");
    expect(meta.taskStatus).toBe("taken");
    expect(meta.takenBy).toBe("fleet-1");
    expect(meta.takenAt).toBe("2026-07-11T00:00:00.000Z");
    expect(meta.doneAt).toBeUndefined();
    // A task-type note with no task_status leaves taskStatus absent (treated as open elsewhere).
    expect(
      parseNote("---\ntype: task\n---\nx", { fallbackId: "t" }).meta.taskStatus,
    ).toBeUndefined();
    // An invalid task_status is ignored.
    expect(
      parseNote("---\ntype: task\ntask_status: bogus\n---\nx", { fallbackId: "t" }).meta.taskStatus,
    ).toBeUndefined();
  });

  it("reads code_areas frontmatter into codeAreas (absent when empty)", () => {
    const raw = [
      "---",
      "id: session-refresh",
      "code_areas:",
      "  - src/auth/session.ts",
      "  - apps/web/src/routes/**",
      "---",
      "Body.",
    ].join("\n");
    const { meta } = parseNote(raw, { fallbackId: "session-refresh" });
    expect(meta.codeAreas).toEqual(["src/auth/session.ts", "apps/web/src/routes/**"]);
    expect(parseNote("just a body", { fallbackId: "n" }).meta.codeAreas).toBeUndefined();
    // scalar coerces to a one-element list, like tags
    expect(
      parseNote("---\ncode_areas: src/one.ts\n---\nx", { fallbackId: "n" }).meta.codeAreas,
    ).toEqual(["src/one.ts"]);
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

  it("round-trips code_areas through serialize -> parse", () => {
    const md = serializeNote(
      { id: "rt", title: "RT", code_areas: ["src/a.ts", "packages/b/**"] },
      "Body.\n",
    );
    const { meta } = parseNote(md, { fallbackId: "x" });
    expect(meta.codeAreas).toEqual(["src/a.ts", "packages/b/**"]);
  });

  it("round-trips task fields through serialize -> parse", () => {
    const md = serializeNote(
      {
        id: "task-rt",
        title: "Task RT",
        type: "task",
        task_status: "done",
        taken_by: "fleet-2",
        taken_at: "2026-07-11T00:00:00.000Z",
        done_at: "2026-07-11T01:00:00.000Z",
      },
      "Body.\n",
    );
    const { meta } = parseNote(md, { fallbackId: "x" });
    expect(meta.type).toBe("task");
    expect(meta.taskStatus).toBe("done");
    expect(meta.takenBy).toBe("fleet-2");
    expect(meta.takenAt).toBe("2026-07-11T00:00:00.000Z");
    expect(meta.doneAt).toBe("2026-07-11T01:00:00.000Z");
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
