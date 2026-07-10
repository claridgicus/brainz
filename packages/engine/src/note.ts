import matter from "gray-matter";
import { slugify } from "./slugify.js";
import type { ConceptMeta, ConceptStatus, ConceptType } from "./types.js";

const CONCEPT_TYPES: readonly ConceptType[] = [
  "concept",
  "domain",
  "feature",
  "story",
  "spec",
  "workflow",
  "decision",
  "constraint",
  "pattern",
  "glossary",
];

const CONCEPT_STATUSES: readonly ConceptStatus[] = ["active", "draft", "deprecated"];

/** Concept metadata derivable from a note's markdown alone (no file path). */
export type NoteMeta = Omit<ConceptMeta, "filePath">;

export interface ParseNoteOptions {
  /**
   * Id used when frontmatter has no `id` — typically the filename without
   * extension. It is slugified; a frontmatter `id` is used as-is.
   */
  fallbackId: string;
}

export interface ParsedNote {
  meta: NoteMeta;
  /** Markdown body sans frontmatter (leading blank line stripped). */
  body: string;
  /** Wiki-link targets in the body, deduped, in order of first appearance. */
  wikiLinks: string[];
  /** Typed edges declared in frontmatter `relations:` (relation -> target ids). */
  relations: Record<string, string[]>;
  /** Raw frontmatter data (for callers that need unknown-key preservation). */
  frontmatter: Record<string, unknown>;
}

function asIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Parse a markdown note (frontmatter + body) into meta, body, wiki-links and typed relations. */
export function parseNote(markdown: string, opts: ParseNoteOptions): ParsedNote {
  const { data, content } = matter(markdown);
  const fm = data as Record<string, unknown>;

  const rawId = typeof fm.id === "string" ? fm.id.trim() : "";
  const id = rawId || slugify(opts.fallbackId);

  const rawTitle = typeof fm.title === "string" ? fm.title.trim() : "";
  const title = rawTitle || id;

  const type: ConceptType = CONCEPT_TYPES.includes(fm.type as ConceptType)
    ? (fm.type as ConceptType)
    : "concept";
  const status: ConceptStatus = CONCEPT_STATUSES.includes(fm.status as ConceptStatus)
    ? (fm.status as ConceptStatus)
    : "active";

  const product =
    typeof fm.product === "string" && fm.product.trim() ? fm.product.trim() : undefined;

  const relations: Record<string, string[]> = {};
  if (fm.relations && typeof fm.relations === "object" && !Array.isArray(fm.relations)) {
    for (const [key, value] of Object.entries(fm.relations as Record<string, unknown>)) {
      const targets = asStringArray(value);
      if (targets.length > 0) relations[key] = targets;
    }
  }

  const body = content.replace(/^\r?\n/, "");

  const codeAreas = asStringArray(fm.code_areas);

  const meta: NoteMeta = {
    id,
    title,
    type,
    status,
    product,
    tags: asStringArray(fm.tags),
    ...(codeAreas.length > 0 ? { codeAreas } : {}),
    createdAt: asIso(fm.createdAt),
    updatedAt: asIso(fm.updatedAt),
  };

  return { meta, body, wikiLinks: extractWikiLinks(body), relations, frontmatter: fm };
}

/**
 * Split a note into its frontmatter map (shallow copy) and raw content
 * (leading newline preserved) — for read-modify-write flows that must keep
 * unknown frontmatter keys and byte-identical bodies.
 */
export function readFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const parsed = matter(markdown);
  return { frontmatter: { ...(parsed.data as Record<string, unknown>) }, content: parsed.content };
}

/**
 * Serialize a note back to markdown: YAML frontmatter (unknown keys pass
 * through untouched) followed by the body.
 */
export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body, frontmatter);
}

/**
 * Extract wiki-link targets ([[id]] and [[id|label]]) from a markdown body,
 * ignoring links inside fenced code blocks and inline code spans.
 * Returns unique ids in order of first appearance.
 */
export function extractWikiLinks(body: string): string[] {
  const cleaned = stripCode(body);
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const target = m[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      ids.push(target);
    }
  }
  return ids;
}

/** Blank out fenced code blocks and inline code spans so links inside them are ignored. */
function stripCode(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
      }
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    // Remove inline code spans (single or multi-backtick delimited).
    out.push(line.replace(/(`+)[^`]*\1/g, " "));
  }
  return out.join("\n");
}
