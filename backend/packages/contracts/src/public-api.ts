import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Public-API wire contracts (the `/api/v1` surface for external systems).
//
// First use-case: "break down an initiative". An external caller picks a public,
// inline (no-GitHub) pipeline and supplies an initial brief; the platform runs it
// headlessly and persists the result in the DB for asynchronous retrieval (poll
// `GET /jobs/:id` or subscribe to `GET /jobs/:id/events` over SSE). Nothing is
// committed to GitHub.
// ---------------------------------------------------------------------------

/** Start an initiative run. */
export const createInitiativeJobSchema = v.object({
  /** Id of a PUBLIC, inline pipeline (e.g. `pl_initiative_breakdown`). */
  pipelineId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The initiative brief — becomes the run's task description. */
  input: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50_000)),
  /** Optional human-readable title for the run; defaults to a truncated `input`. */
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
})
export type CreateInitiativeJobInput = v.InferOutput<typeof createInitiativeJobSchema>

/**
 * The coarse public job status, mapped from the internal execution status:
 * `done` → `succeeded`, `failed` → `failed`, everything else (running / paused /
 * blocked) → `running`. External callers never see the block/board internals.
 */
export const publicJobStatusSchema = v.picklist(['running', 'succeeded', 'failed'])
export type PublicJobStatus = v.InferOutput<typeof publicJobStatusSchema>

/** The persisted result of a finished run — the terminal step's output. */
export const publicJobResultSchema = v.object({
  /** The agent's prose output (the final reply). */
  output: v.string(),
  /** The structured decomposition, when the agent produced one (`step.custom`). */
  data: v.nullable(v.unknown()),
})
export type PublicJobResult = v.InferOutput<typeof publicJobResultSchema>

/** A public job resource — the external view of a headless initiative run. */
export const publicJobSchema = v.object({
  jobId: v.string(),
  status: publicJobStatusSchema,
  pipelineId: v.string(),
  createdAt: v.number(),
  /** Present once the run reaches `succeeded`; null while running or on failure. */
  result: v.nullable(publicJobResultSchema),
  /** Present when `status` is `failed`; null otherwise. */
  error: v.nullable(v.object({ code: v.string(), message: v.string() })),
})
export type PublicJob = v.InferOutput<typeof publicJobSchema>

/** The `202` returned by `POST /initiatives`: the job id + where to follow it. */
export const initiativeAcceptedSchema = v.object({
  jobId: v.string(),
  status: publicJobStatusSchema,
  links: v.object({ self: v.string(), events: v.string() }),
})
export type InitiativeAccepted = v.InferOutput<typeof initiativeAcceptedSchema>
