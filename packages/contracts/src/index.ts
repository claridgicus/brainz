/**
 * @brainz/contracts — single source of truth for every Brainz wire shape.
 *
 * Every shape that crosses a process boundary (MCP tool I/O, cloud REST API,
 * CLI --json output) is defined once here as a zod schema; TS types come from
 * z.infer. Pure and Workers-safe: zod + type-only imports from @brainz/engine.
 */

/** Bump on breaking wire-shape changes. */
export const CONTRACTS_VERSION = "11";

export * from "./domain.js";
export * from "./mcp.js";
export * from "./api.js";
export * from "./cli.js";
