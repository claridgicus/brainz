/**
 * The `reminder` line on `complete_task` results, single-sourced here so the
 * local stdio server and Brainz Cloud say the same thing.
 */

/**
 * The directive reminder: after a task is done, index what changed. Sent on
 * `bz_` key and local stdio connections, which the user set up themselves.
 */
export const TASK_COMPLETE_REMINDER =
  "Task complete. Now index what changed via upsert_concept so the knowledge graph stays true to the codebase — new/updated features, specs, decisions, and constraints.";

/**
 * The neutral form of {@link TASK_COMPLETE_REMINDER} for directory surfaces
 * (Brainz Cloud OAuth and public-vault connections): states what happened and
 * what didn't, without telling the model to call a tool the user didn't ask
 * for (SPEC-CLOUD.md "Directory policy").
 */
export const TASK_COMPLETE_NOTICE =
  "Task marked done, with the outcome appended to its body. Other concepts in the graph are not updated automatically.";

/** The relation fields of a `create_task` request. */
export interface CreateTaskLinks {
  domain?: string;
  epic?: string;
  realizes?: string[];
  governedBy?: string[];
}

/**
 * The relations map a new task is created with (`create_task`, both MCP
 * servers and the cloud REST POST .../tasks): `part_of` its domain then its
 * epic, `realizes`, `governed_by`. Undefined when there are none.
 */
export function createTaskRelations(links: CreateTaskLinks): Record<string, string[]> | undefined {
  const relations: Record<string, string[]> = {};
  const partOf = [links.domain, links.epic].filter((x): x is string => !!x);
  if (partOf.length > 0) relations.part_of = [...new Set(partOf)];
  if (links.realizes && links.realizes.length > 0) relations.realizes = links.realizes;
  if (links.governedBy && links.governedBy.length > 0) relations.governed_by = links.governedBy;
  return Object.keys(relations).length > 0 ? relations : undefined;
}
