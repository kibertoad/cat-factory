import * as v from 'valibot'
import { blockTypeSchema, createTaskTypeSchema, taskTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Public-API wire contracts (the `/api/v1` surface for external systems).
//
// First use-case: "break down an initiative". An external caller picks a public,
// inline (no-GitHub) pipeline and supplies an initial brief; the platform runs it
// headlessly and persists the result in the DB for asynchronous retrieval (poll
// `GET /jobs/:id` or subscribe to `GET /jobs/:id/events` over SSE). Nothing is
// committed to GitHub.
//
// Second use-case: "basic board workloads". A key holder lists the workspace's
// services, creates a task under one, starts it, and follows its status — the
// external counterparts of the SPA's board operations, scoped to the key's
// workspace (see the `publicTask` / `publicService` resources below). Board/engine
// internals are never leaked: these are deliberately small projections of a `Block`.
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

// ---------------------------------------------------------------------------
// Basic board workloads: services + tasks.
// ---------------------------------------------------------------------------

/**
 * A task's lifecycle status as exposed externally. Mirrors the internal block-status
 * members but is a DECOUPLED public type, so the external contract stays stable if the
 * board ever adds an internal status. Unlike the coarse job status, a board task's real
 * lifecycle status is the useful thing here (`planned` → `in_progress` → `pr_ready`/`done`).
 */
export const publicTaskStatusSchema = v.picklist([
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'pr_ready',
  'done',
])
export type PublicTaskStatus = v.InferOutput<typeof publicTaskStatusSchema>

/** A service (a board service frame) as exposed externally — a small projection of the frame block. */
export const publicServiceSchema = v.object({
  serviceId: v.string(),
  title: v.string(),
  description: v.string(),
  /** The service's architectural classification (service / frontend / library / …). */
  type: blockTypeSchema,
  status: publicTaskStatusSchema,
})
export type PublicService = v.InferOutput<typeof publicServiceSchema>

export const publicServiceListSchema = v.object({ services: v.array(publicServiceSchema) })
export type PublicServiceList = v.InferOutput<typeof publicServiceListSchema>

/** A board task as exposed externally — a small projection of the task block. */
export const publicTaskSchema = v.object({
  taskId: v.string(),
  /** The enclosing service frame this task belongs to. */
  serviceId: v.string(),
  title: v.string(),
  description: v.string(),
  taskType: taskTypeSchema,
  status: publicTaskStatusSchema,
  /** 0..1 progress of the task's current run; 0 when not started. */
  progress: v.number(),
  /** The live run's id once the task has been started; null while `planned`. */
  executionId: v.nullable(v.string()),
  /** The web URL of the PR the run opened, once one exists; null otherwise. */
  pullRequestUrl: v.nullable(v.string()),
})
export type PublicTask = v.InferOutput<typeof publicTaskSchema>

export const publicTaskListSchema = v.object({ tasks: v.array(publicTaskSchema) })
export type PublicTaskList = v.InferOutput<typeof publicTaskListSchema>

/**
 * Create a task under a service. A deliberately MINIMAL external input mapped onto the
 * internal `AddTaskInput` — it exposes only title/description/taskType, not the rich
 * internal knobs (risk/model presets, pinned pipeline, agent config), so the public
 * surface stays small and stable.
 */
export const createPublicTaskSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /** The kind of work; omitted → `feature`. `recurring` is not creatable here. */
  taskType: v.optional(createTaskTypeSchema),
})
export type CreatePublicTaskInput = v.InferOutput<typeof createPublicTaskSchema>

/**
 * Start (run) a task. `pipelineId` is optional — it falls back to the task's pinned
 * pipeline; a task with neither is rejected with `pipeline_required`.
 */
export const startPublicTaskSchema = v.object({
  pipelineId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
})
export type StartPublicTaskInput = v.InferOutput<typeof startPublicTaskSchema>

/**
 * Edit a task's mutable fields (typically before it runs) — the external counterpart of the
 * SPA's inline title/description edit. Deliberately narrower than the internal `updateBlock`
 * patch (which also carries model/risk/pipeline pins and board-layout knobs that have no
 * external meaning): the public surface exposes only the two human-authored fields, so it
 * stays small and stable. Both fields are optional; an empty patch is a harmless no-op.
 */
export const updatePublicTaskSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
})
export type UpdatePublicTaskInput = v.InferOutput<typeof updatePublicTaskSchema>

// ---------------------------------------------------------------------------
// Richer run projection + live stream (the task-lifecycle surface).
// ---------------------------------------------------------------------------

/**
 * A task run's status as exposed externally. Mirrors the internal `ExecutionStatus`
 * members but is a DECOUPLED public type, so the external contract stays stable if the
 * engine ever adds an internal status. Unlike the coarse initiative-job status
 * (`running`/`succeeded`/`failed`), the richer run view surfaces the parked states a
 * caller may want to react to (`blocked` = awaiting a human, `paused` = spend-gated).
 */
export const publicRunStatusSchema = v.picklist(['running', 'blocked', 'paused', 'done', 'failed'])
export type PublicRunStatus = v.InferOutput<typeof publicRunStatusSchema>

/** A single step of a task run — a small projection of the internal `PipelineStep`. */
export const publicRunStepSchema = v.object({
  /** The step's agent kind (`architect`, `coder`, `ci`, `merger`, a custom kind, …). */
  agentKind: v.string(),
  /** Lifecycle state: `pending` → `working` → `waiting_decision` → `done`. */
  state: v.picklist(['pending', 'working', 'waiting_decision', 'done']),
  /** 0..1 progress of this step. */
  progress: v.number(),
  /** Live subtask counts while an async (container) step runs; null when none. */
  subtasks: v.nullable(
    v.object({ completed: v.number(), inProgress: v.number(), total: v.number() }),
  ),
})
export type PublicRunStep = v.InferOutput<typeof publicRunStepSchema>

/**
 * The rich external view of a task's run — per-step status/progress/subtasks, the failure
 * kind+message, and the PR the run opened (url + branch). A larger projection than the
 * coarse `publicJob`, deliberately scoped to a BOARD task run (created/owned via the public
 * task surface), never a headless initiative job or a raw `ExecutionInstance`.
 */
export const publicRunSchema = v.object({
  runId: v.string(),
  taskId: v.string(),
  status: publicRunStatusSchema,
  createdAt: v.number(),
  /** Index of the step the run is currently on. */
  currentStep: v.number(),
  steps: v.array(publicRunStepSchema),
  /** The PR the run opened, once one exists; null otherwise. */
  pullRequest: v.nullable(v.object({ url: v.string(), branch: v.nullable(v.string()) })),
  /** Present when `status` is `failed` (the failure kind + message); null otherwise. */
  error: v.nullable(v.object({ code: v.string(), message: v.string() })),
})
export type PublicRun = v.InferOutput<typeof publicRunSchema>

// ---------------------------------------------------------------------------
// Pipeline discovery.
// ---------------------------------------------------------------------------

/**
 * A pipeline as exposed externally — enough to pick a `pipelineId` for `start` and know
 * whether it is safe to run headlessly. Closes the gap where `start` demands a `pipelineId`
 * for an unpinned task yet nothing lists the valid ids. A small projection of the internal
 * `Pipeline` (its id/name + the enabled step chain), plus the two headless-relevant flags.
 */
export const publicPipelineSchema = v.object({
  pipelineId: v.string(),
  name: v.string(),
  /** The enabled step chain, in order (each an agent kind). */
  steps: v.array(v.string()),
  /**
   * Whether this pipeline is exposed as a PUBLIC initiative pipeline (`POST /initiatives`).
   * A non-public pipeline can still back a board task `start` when pinned or passed by id.
   */
  public: v.boolean(),
  /**
   * Whether the pipeline is safe to run headlessly (every enabled step is inline — no
   * container/GitHub push — and none parks on a human gate). A headless-startable pipeline
   * can be driven end-to-end with no interactive user; others may park awaiting input.
   */
  headlessStartable: v.boolean(),
})
export type PublicPipeline = v.InferOutput<typeof publicPipelineSchema>

export const publicPipelineListSchema = v.object({ pipelines: v.array(publicPipelineSchema) })
export type PublicPipelineList = v.InferOutput<typeof publicPipelineListSchema>
