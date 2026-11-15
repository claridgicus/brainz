/**
 * Burndown wire shapes (SPEC.md "Burndown"): the `burndown` MCP tool input,
 * the REST query, and the result both return. Mirrors engine's
 * `BurndownResult` / `TaskEvent` (drift-guarded below).
 */
import { z } from "zod";
import type { BurndownResult, TaskEvent } from "@brainz/engine";

export const BURNDOWN_METRIC_NAMES = [
  "series",
  "scopeChanges",
  "velocity",
  "projection",
  "cycle",
  "agents",
  "stale",
] as const;

export const TASK_EVENT_KIND_NAMES = [
  "created",
  "taken",
  "released",
  "done",
  "reopened",
  "scope_added",
  "scope_removed",
  "estimated",
  "deleted",
] as const;

export const taskEventSchema = z
  .object({
    at: z.string(),
    task: z.string(),
    kind: z.enum(TASK_EVENT_KIND_NAMES),
    by: z.string().optional(),
    scope: z.string().optional(),
    points: z.number().nullable().optional(),
    /** Synthesized from the task's fields (pre-log history); replays first at its instant. */
    backfilled: z.literal(true).optional(),
  })
  .strict();

const isoOrDay = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)), {
    message: "expected an ISO date (YYYY-MM-DD) or timestamp",
  });

export const burndownInputSchema = z.object({
  scope: z
    .string()
    .optional()
    .describe(
      "A concept id (iteration, milestone, feature, domain, …) or `tag:<tag>`. Omit for every task in the vault.",
    ),
  from: isoOrDay
    .optional()
    .describe("Window start (YYYY-MM-DD or ISO). Default: the scope's startDate, else 8 weeks ago."),
  to: isoOrDay
    .optional()
    .describe("Window end (YYYY-MM-DD or ISO). Default: the later of the scope's endDate and now."),
  bucket: z
    .enum(["day", "week"])
    .optional()
    .describe("Series granularity. Default: day for windows up to 120 days, else week."),
  unit: z
    .enum(["tasks", "points"])
    .optional()
    .describe("Count tasks (default) or sum their `estimate` points."),
  staleAfterHours: z
    .number()
    .positive()
    .optional()
    .describe("A claim held longer than this is stale (default 24)."),
  metrics: z
    .array(z.enum(BURNDOWN_METRIC_NAMES))
    .optional()
    .describe(
      "Sections to include: series, scopeChanges, velocity, projection, cycle, agents, stale (default all).",
    ),
});
export type BurndownInputArgs = z.infer<typeof burndownInputSchema>;

/** GET /api/vaults/:id/burndown query (string params; `metrics` comma-separated). */
export const burndownQuerySchema = z.object({
  scope: z.string().optional(),
  from: isoOrDay.optional(),
  to: isoOrDay.optional(),
  bucket: z.enum(["day", "week"]).optional(),
  unit: z.enum(["tasks", "points"]).optional(),
  staleAfterHours: z.coerce.number().positive().optional(),
  metrics: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((m) => m.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(BURNDOWN_METRIC_NAMES)).optional()),
});

const statsSchema = z
  .object({
    count: z.number().int(),
    median: z.number().nullable(),
    p85: z.number().nullable(),
    mean: z.number().nullable(),
  })
  .strict();

export const burndownResultSchema = z
  .object({
    scope: z
      .object({
        id: z.string().nullable(),
        kind: z.enum(["vault", "concept", "tag"]),
        title: z.string(),
        type: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      })
      .strict(),
    window: z
      .object({
        from: z.string(),
        to: z.string(),
        now: z.string(),
        bucket: z.enum(["day", "week"]),
        unit: z.enum(["tasks", "points"]),
      })
      .strict(),
    totals: z
      .object({
        scope: z.number(),
        done: z.number(),
        open: z.number(),
        taken: z.number(),
        unestimated: z.number().int(),
      })
      .strict(),
    series: z
      .array(
        z
          .object({
            at: z.string(),
            scope: z.number().nullable(),
            done: z.number().nullable(),
            open: z.number().nullable(),
            taken: z.number().nullable(),
            ideal: z.number().nullable(),
          })
          .strict(),
      )
      .optional(),
    scopeChanges: z
      .array(
        z
          .object({
            at: z.string(),
            task: z.string(),
            title: z.string(),
            change: z.enum(["added", "removed"]),
            points: z.number().nullable(),
          })
          .strict(),
      )
      .optional(),
    velocity: z
      .object({
        by: z.enum(["iteration", "week"]),
        periods: z.array(
          z
            .object({
              label: z.string(),
              id: z.string().optional(),
              from: z.string(),
              to: z.string(),
              done: z.number(),
              complete: z.boolean(),
            })
            .strict(),
        ),
        average: z.number().nullable(),
      })
      .strict()
      .optional(),
    projection: z
      .object({
        remaining: z.number(),
        ratePerWeek: z.object({ mean: z.number(), stdev: z.number() }).strict(),
        samples: z.number().int(),
        likely: z.string().nullable(),
        optimistic: z.string().nullable(),
        pessimistic: z.string().nullable(),
        onTrack: z.boolean().nullable(),
        reason: z.string().optional(),
      })
      .strict()
      .optional(),
    cycle: z
      .object({
        leadHours: statsSchema,
        cycleHours: statsSchema,
        byAgent: z.array(
          z.object({ agent: z.string(), leadHours: statsSchema, cycleHours: statsSchema }).strict(),
        ),
      })
      .strict()
      .optional(),
    agents: z
      .array(
        z
          .object({
            agent: z.string(),
            held: z.number().int(),
            done: z.number().int(),
            medianLeadHours: z.number().nullable(),
            medianCycleHours: z.number().nullable(),
            stale: z.number().int(),
          })
          .strict(),
      )
      .optional(),
    stale: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            takenBy: z.string().nullable(),
            takenAt: z.string(),
            ageHours: z.number(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type BurndownResultWire = z.infer<typeof burndownResultSchema>;

// Compile-time drift guards against the engine types.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
type _BurndownInSync = Expect<MutuallyAssignable<z.infer<typeof burndownResultSchema>, BurndownResult>>;
type _TaskEventInSync = Expect<MutuallyAssignable<z.infer<typeof taskEventSchema>, TaskEvent>>;
