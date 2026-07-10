export type {
  ConceptType,
  ConceptStatus,
  ConceptMeta,
  Concept,
  Edge,
  SearchOptions,
  SearchHit,
  RelatedOptions,
  RelatedNode,
  ContextOptions,
  ContextBundle,
  UpsertInput,
  VaultStats,
} from "./types.js";

export { slugify } from "./slugify.js";

export { extractWikiLinks, parseNote, readFrontmatter, serializeNote } from "./note.js";
export type { NoteMeta, ParsedNote, ParseNoteOptions } from "./note.js";

export { cosineSim, packVector, rrfFuse, unpackVector } from "./search.js";
export type { FusedResult } from "./search.js";

export { bfsRelated } from "./graph.js";

export { assembleContext } from "./context.js";
export type { AssembleContextOptions, ContextSource } from "./context.js";

export { validateGraph } from "./validate.js";
export type { GraphIssue, GraphValidation } from "./validate.js";
