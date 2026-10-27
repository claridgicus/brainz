/**
 * Local (filesystem) host helpers for dreaming. The sweep itself is engine
 * code; the Vault snapshots its notes, applies the plan as markdown writes,
 * and keeps each dream's record in `<vault>/.dreams/<id>.json` — NOT under
 * `.brainz/`, because preimages are not derivable state.
 */
import { readFrontmatter, serializeNote } from "@brainz/engine";
import type { DreamConcept, DreamDiaryEntry } from "@brainz/engine";

/** One applied write, as raw markdown so revert is byte-exact. */
export interface LocalDreamOp {
  id: string;
  filePath: string;
  /** File contents before the dream; null ⇒ the dream created it. */
  beforeRaw: string | null;
  /** File contents the dream wrote; null ⇒ the dream removed it. */
  afterRaw: string | null;
}

/** What `.dreams/<id>.json` holds. */
export interface LocalDreamRecord {
  entry: DreamDiaryEntry;
  ops: LocalDreamOp[];
}

/** Render a planned concept as markdown, keeping unknown frontmatter keys of the prior file. */
export function serializeDreamConcept(c: DreamConcept, priorRaw: string | null): string {
  const data = priorRaw ? readFrontmatter(priorRaw).frontmatter : {};
  const setOrDelete = (key: string, value: unknown, keep: boolean) => {
    if (keep) data[key] = value;
    else delete data[key];
  };
  data.id = c.id;
  data.title = c.title;
  data.type = c.type;
  data.status = c.status;
  setOrDelete("product", c.product, c.product !== undefined);
  data.tags = c.tags;
  setOrDelete("code_areas", c.codeAreas, c.codeAreas.length > 0);
  setOrDelete("task_status", c.taskStatus, c.taskStatus !== undefined);
  setOrDelete("taken_by", c.takenBy, c.takenBy !== undefined);
  setOrDelete("taken_at", c.takenAt, c.takenAt !== undefined);
  setOrDelete("done_at", c.doneAt, c.doneAt !== undefined);
  setOrDelete("relations", c.relations, Object.keys(c.relations).length > 0);
  setOrDelete("createdAt", c.createdAt, c.createdAt !== undefined);
  setOrDelete("updatedAt", c.updatedAt, c.updatedAt !== undefined);
  return serializeNote(data, c.body.endsWith("\n") ? c.body : `${c.body}\n`);
}
