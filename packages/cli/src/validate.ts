import type { CliValidateJson, CliValidationIssue } from "@brainz/contracts";
import { slugify, Vault } from "@brainz/core";
import matter from "gray-matter";
import * as fs from "node:fs";
import * as path from "node:path";

/** One validation issue; `file` is relative to the vault dir when the issue maps to one file. */
export type ValidationIssue = CliValidationIssue;

/** The `brainz validate --json` report — shape owned by @brainz/contracts. */
export type ValidationResult = CliValidateJson;

/** Recursively list .md files, mirroring core's scan (skips dot-dirs & node_modules). */
function scanMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Validate a vault.
 *
 * Errors (exit 1): duplicate ids, unparseable frontmatter. These are checked by
 * scanning the markdown files directly, because core's reindex silently skips
 * files it cannot parse and lets the last file win on id collisions.
 *
 * Warnings (exit 0): edges pointing at ids with no concept ("pending" concepts
 * per SPEC — wiki-links to unknown ids are allowed).
 */
export async function validateVault(dir: string): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const rel = (p: string): string => path.relative(dir, p) || p;

  const filesById = new Map<string, string[]>();
  for (const file of scanMarkdownFiles(dir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      errors.push({ file: rel(file), message: `unreadable file: ${(e as Error).message}` });
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = matter(raw).data as Record<string, unknown>;
    } catch (e) {
      const detail = (e as Error).message.split("\n")[0];
      errors.push({ file: rel(file), message: `unparseable frontmatter: ${detail}` });
      continue;
    }
    // Same id derivation as core's parseNote: frontmatter id, else slugified filename.
    const rawId = typeof data.id === "string" ? data.id.trim() : "";
    const id = rawId || slugify(path.basename(file).replace(/\.md$/i, ""));
    const list = filesById.get(id) ?? [];
    list.push(rel(file));
    filesById.set(id, list);
  }

  for (const [id, files] of filesById) {
    if (files.length > 1) {
      errors.push({ message: `duplicate id "${id}" in ${files.length} files: ${files.join(", ")}` });
    }
  }

  const vault = await Vault.open(dir);
  try {
    for (const edge of vault.edges()) {
      if (vault.getConcept(edge.to) === null) {
        warnings.push({
          message: `broken link: ${edge.from} —${edge.relation}→ ${edge.to} (no such concept; treated as pending)`,
        });
      }
    }
    const stats = vault.stats();
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      concepts: stats.concepts,
      edges: stats.edges,
    };
  } finally {
    vault.close();
  }
}
