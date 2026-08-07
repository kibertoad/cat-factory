import * as v from 'valibot'
import { documentSourceKindSchema } from './documents.js'
import { descriptorFieldValuesSchema } from './form-fields.js'
import { notificationSchema } from './notifications.js'
import { blockTypeSchema, createTaskTypeSchema, taskTypeSchema } from './primitives.js'
import { publicApiScopeSchema } from './public-api-keys.js'
import { taskSourceKindSchema } from './tasks.js'

// ---------------------------------------------------------------------------
// Public-API wire contracts (the `/api/v1` surface for external systems).
//
// First use-case: "headless jobs". An external caller picks a public, inline
// (no-GitHub) pipeline and supplies an initial brief; the platform runs it
// headlessly and persists the result in the DB for asynchronous retrieval (poll
// `GET /jobs/:id` or subscribe to `GET /jobs/:id/events` over SSE). Nothing is
// committed to GitHub. The first such pipeline breaks an initiative down, but
// the job resource is generic over any public inline pipeline.
//
// Second use-case: "basic board workloads". A key holder lists the workspace's
// services, creates a task under one, starts it, and follows its status — the
// external counterparts of the SPA's board operations, scoped to the key's
// workspace (see the `publicTask` / `publicService` resources below). Board/engine
// internals are never leaked: these are deliberately small projections of a `Block`.
// ---------------------------------------------------------------------------

// ---- shared pagination primitives (used by every bounded list on this surface) ----

/**
 * An OPAQUE keyset pagination cursor. Callers must treat it as a black box and echo it back
 * verbatim — its encoding is an implementation detail (today a base64url `<sortKey>|<id>` pair)
 * that may change. Keyset, not offset: an offset page shifts under concurrent inserts, silently
 * skipping or repeating rows, which is exactly what a polling integration must never see.
 */
const cursorSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/**
 * Rows one page may return. Arrives as a query STRING, so it is digit-checked BEFORE the numeric
 * coercion — `Number()` alone also accepts `1e9`, `0x64` and `' '`, which would read as plausible
 * limits rather than the 400 a malformed request deserves. The hard `maxValue` is what makes the
 * bound a real backstop rather than a suggestion (a caller cannot ask for the whole table back by
 * passing a huge limit).
 */
const pageLimitSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(100),
)

/** An epoch-ms query filter: digits only, for the same reason as {@link pageLimitSchema}. */
const epochMsQuerySchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number of epoch milliseconds'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
)

/** Start a headless job (run a public, inline pipeline against a brief). */
export const createPublicJobSchema = v.object({
  /** Id of a PUBLIC, inline pipeline (e.g. `pl_initiative_breakdown`). */
  pipelineId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The brief the pipeline runs against; becomes the run's task description. */
  input: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50_000)),
  /** Optional human-readable title for the run; defaults to a truncated `input`. */
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
})
export type CreatePublicJobInput = v.InferOutput<typeof createPublicJobSchema>

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

/**
 * Who a run was started FOR, as the provisioner of the starting key named it
 * (`externalIdentity` on the key resource). `null` is a real and common state: a run started from
 * the app, by a schedule, or by a key minted with no identity has none, and the platform never
 * guesses one.
 *
 * PINNED onto the run when it is admitted, never resolved from the key at read time. Three things
 * follow, and each of them is why: the value survives its key being revoked (which is what an
 * integration does when a person leaves, precisely when the mapping is still wanted); reading a
 * run costs no key lookup, so a page of runs is not a page of key reads; and a run keeps naming
 * the identity that STARTED it rather than whatever a re-minted key says today.
 */
export const publicRunExternalIdentitySchema = v.nullable(v.string())

/** A public job resource — the external view of a headless pipeline run. */
export const publicJobSchema = v.object({
  jobId: v.string(),
  status: publicJobStatusSchema,
  pipelineId: v.string(),
  createdAt: v.number(),
  /** Who this run was started for ({@link publicRunExternalIdentitySchema}). */
  externalIdentity: publicRunExternalIdentitySchema,
  /** Present once the run reaches `succeeded`; null while running or on failure. */
  result: v.nullable(publicJobResultSchema),
  /** Present when `status` is `failed`; null otherwise. */
  error: v.nullable(v.object({ code: v.string(), message: v.string() })),
})
export type PublicJob = v.InferOutput<typeof publicJobSchema>

/**
 * The workspace's headless jobs, newest first, bounded. Closes the gap where an
 * integration that lost its stored job ids (a restart, a fresh deployment) could never
 * re-discover its own in-flight runs — `GET /jobs/:id` needs an id it no longer has.
 *
 * Scoped exactly like the single-job read: ONLY runs anchored on a headless internal block,
 * so it can never enumerate the workspace's ordinary board runs.
 */
export const publicJobListSchema = v.object({
  jobs: v.array(publicJobSchema),
  /** Cursor for the next page, or null when this was the last page. See `publicTaskListSchema`. */
  nextCursor: v.nullable(v.string()),
})
export type PublicJobList = v.InferOutput<typeof publicJobListSchema>

/**
 * Query params for `GET /api/v1/jobs`. `status` filters on the COARSE public job status, which
 * the backend expands to the internal execution statuses it maps from (`running` covers a run
 * that is running, spend-`paused`, or parked `blocked` — all of which read as `running`
 * externally), so the filter agrees with the `status` field a caller sees on each job.
 */
export const listPublicJobsQuerySchema = v.object({
  /** Rows per page (1..100); omitted → 25. */
  limit: v.optional(pageLimitSchema),
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: v.optional(cursorSchema),
  /** Return only jobs in this coarse status. */
  status: v.optional(publicJobStatusSchema),
  /** Return only jobs created at or after this epoch-ms stamp (the incremental-poll filter). */
  since: v.optional(epochMsQuerySchema),
})
export type ListPublicJobsQuery = v.InferOutput<typeof listPublicJobsQuerySchema>

/** The `202` returned by `POST /jobs`: the job id + where to follow it. */
export const publicJobAcceptedSchema = v.object({
  jobId: v.string(),
  status: publicJobStatusSchema,
  links: v.object({ self: v.string(), events: v.string() }),
})
export type PublicJobAccepted = v.InferOutput<typeof publicJobAcceptedSchema>

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
  /**
   * The live run's id once the task has been started; null while `planned`. Joins onto the
   * rich run projection (`publicRun.runId`) and the decisions surface (`/runs/:runId/...`):
   * one public name for one concept ("execution" is the internal engine vocabulary).
   */
  runId: v.nullable(v.string()),
  /** The web URL of the PR the run opened, once one exists; null otherwise. */
  pullRequestUrl: v.nullable(v.string()),
})
export type PublicTask = v.InferOutput<typeof publicTaskSchema>

export const publicTaskListSchema = v.object({
  tasks: v.array(publicTaskSchema),
  /**
   * Cursor to pass as `?cursor=` for the next page, or null when this was the last page.
   * A non-null cursor does NOT guarantee the next page is non-empty (it means "there may be
   * more"), so a client pages until it comes back null.
   */
  nextCursor: v.nullable(v.string()),
})
export type PublicTaskList = v.InferOutput<typeof publicTaskListSchema>

/**
 * Query params for `GET /api/v1/services/:serviceId/tasks`. The list was previously unbounded —
 * it read the whole board and filtered the service subtree in JS — so a big service returned
 * every task in one response. It is now a bounded, keyset-paginated read with an optional
 * status filter pushed into SQL.
 *
 * There is deliberately NO `since` here (unlike `/jobs`): a board block carries no creation or
 * update timestamp, so a time filter would have to be faked. Ordering is therefore by the stable
 * task id, NOT chronological — ids are random, not monotonic, so the order is deterministic and
 * safe to page over but carries no "newest first" meaning.
 */
export const listPublicServiceTasksQuerySchema = v.object({
  /** Rows per page (1..100); omitted → 50. */
  limit: v.optional(pageLimitSchema),
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: v.optional(cursorSchema),
  /** Return only tasks in this lifecycle status. */
  status: v.optional(publicTaskStatusSchema),
})
export type ListPublicServiceTasksQuery = v.InferOutput<typeof listPublicServiceTasksQuerySchema>

/**
 * The tracker ticket a task is being filed FROM: the linkage a headless intake integration
 * has and the platform otherwise never learns.
 *
 * Without it the only place a caller can put ticket content is `description`, which flattens a
 * structured issue into prose and throws the identity away, so the run cannot write its
 * clarification questions back onto the ticket, a reply on the ticket answers nothing, and a
 * redelivery files a second task for the same issue with no way to tell. Naming the ticket
 * instead makes the platform import it, project it, and attach it to the new task exactly as the
 * app's own "create task from issue" does, so the description stays the caller's own framing and
 * the issue itself (its status, labels, assignee, description and comments, re-read live) is what
 * reaches each agent as context.
 *
 * `ref` is the SAME grammar the internal import takes: a canonical key (`PROJ-123`,
 * `acme/api#7`, `ENG-4`) or a full issue URL. One field rather than three, because the provider's
 * own `parseRef` is what turns either into the canonical external id, and a caller holding a
 * webhook payload has whichever of the two that payload carried.
 */
export const publicTaskTicketSchema = v.object({
  /** Which tracker the ticket lives on: a source this workspace has connected and enabled. */
  source: taskSourceKindSchema,
  /** The ticket's canonical key OR its full issue URL. */
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type PublicTaskTicket = v.InferOutput<typeof publicTaskTicketSchema>

/** Characters of document text ONE uploaded attachment may carry (see {@link publicTaskDocumentSchema}). */
export const MAX_UPLOADED_DOCUMENT_CHARS = 100_000

/** Context documents ONE task creation may attach (imported and uploaded together). */
export const MAX_TASK_DOCUMENTS = 10

/** A page NAMED in a document source the workspace has connected. See {@link publicTaskDocumentSchema}. */
export const publicTaskSourceDocumentSchema = v.object({
  kind: v.literal('source'),
  /** A document source this workspace has connected. */
  source: documentSourceKindSchema,
  /**
   * The page's id or its full URL: the SAME grammar the app's own import takes, resolved by that
   * source's `parseRef`, so a caller passes whichever form it happens to hold.
   */
  ref: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
})
export type PublicTaskSourceDocument = v.InferOutput<typeof publicTaskSourceDocumentSchema>

/** A document body CARRIED by the caller. See {@link publicTaskDocumentSchema}. */
export const publicTaskUploadedDocumentSchema = v.object({
  kind: v.literal('upload'),
  /** Names the document for the agent (it becomes the attachment's heading and filename). */
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /**
   * The document text, as Markdown. Refused when it yields no readable text at all (a body of
   * pure markup would reach the agent as an empty attachment).
   */
  content: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_UPLOADED_DOCUMENT_CHARS)),
})
export type PublicTaskUploadedDocument = v.InferOutput<typeof publicTaskUploadedDocumentSchema>

/**
 * A requirements document to attach to the task being created: the spec the work is to be built
 * against, in whichever of the two forms the caller holds it.
 *
 * This is what makes `/api/v1` usable for spec-sized intake at all. `description` is capped at
 * 2,000 characters because it is a task's own framing, echoed into every prompt; a PRD pasted
 * into it would be truncated, and the 50,000-character `POST /jobs` brief is a different surface
 * (inline pipelines only, no repository). An attached document has neither limit: the full text
 * is materialised into the run's checkout under `.cat-context/` for a container agent to open, and
 * folded into the prompt for an inline one, exactly as a document a human attached in the app.
 *
 * The two variants differ only in where the text comes from, never in what the run does with it:
 *
 * - `source` NAMES a page in a document source the workspace has connected (Confluence, Notion,
 *   GitHub docs, Figma, Zeplin, Linear). The platform fetches and projects it, so the page stays
 *   the source of truth and a re-import picks up edits.
 * - `upload` CARRIES the text. For a caller that generated the spec, or holds it in a file, or
 *   whose deployment has connected no document source at all. There is no page behind it, so
 *   nothing re-fetches it: the bytes supplied here are what every agent on the run will read.
 */
export const publicTaskDocumentSchema = v.variant('kind', [
  publicTaskSourceDocumentSchema,
  publicTaskUploadedDocumentSchema,
])
export type PublicTaskDocument = v.InferOutput<typeof publicTaskDocumentSchema>

/**
 * Create a task under a service. A deliberately MINIMAL external input mapped onto the
 * internal `AddTaskInput`: it exposes only title/description/taskType/ticket/documents, not the
 * rich internal knobs (risk/model presets, pinned pipeline, agent config), so the public
 * surface stays small and stable.
 */
export const createPublicTaskSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /** The kind of work; omitted → `feature`. `recurring` is not creatable here. */
  taskType: v.optional(createTaskTypeSchema),
  /**
   * The tracker ticket this task is filed from. Omitted ⇒ an unlinked task, exactly as before.
   *
   * Supplied, it is resolved BEFORE the task is created, so an unknown source, an unparseable
   * ref or an issue the tracker will not serve refuses the whole request rather than leaving an
   * unlinked task behind. A ticket already linked to another task is a `409`
   * (`details.reason: 'ticket_already_linked'`, `details.taskId` naming it), which is what a
   * redelivering integration reads as "already filed". The platform holds one task per ticket,
   * so a caller needs no bookkeeping of its own to stay idempotent.
   */
  ticket: v.optional(publicTaskTicketSchema),
  /**
   * Requirements documents to attach to the new task, in the order the agents should read them.
   * Omitted or empty ⇒ an unattached task, exactly as before.
   *
   * Every one of them is resolved or written BEFORE the task is returned, and a failure at any
   * point takes the whole creation with it: a `201` means the task carries every document named
   * here. The alternative is the failure this whole surface exists to avoid, where a run looks
   * perfectly healthy while an agent works from a spec it never received.
   *
   * The per-document cap above bounds one attachment; the CORPUS is bounded separately by the
   * run's materialised-context budget, which is shared with linked tracker issues and cannot be
   * known here. Overflowing it refuses the run's first dispatch and names what did not fit.
   */
  documents: v.optional(v.pipe(v.array(publicTaskDocumentSchema), v.maxLength(MAX_TASK_DOCUMENTS))),
  /**
   * The per-case values for the chosen `taskType`'s form, keyed by field. Omitted ⇒ an unfilled
   * task, exactly as before.
   *
   * This is what makes a REUSABLE OPERATION invocable headlessly
   * (`backend/docs/reusable-operations.md`): a deployment's `acme:introduce-api` was creatable over
   * this API from the day custom types existed, but not one of its declared fields was fillable, so
   * every run started with the brief its form exists to collect left blank.
   *
   * `GET /api/v1/task-types` serves the descriptors this is checked against (for a registered
   * custom type the ones the deployment declared, for a built-in type the fields listed in
   * `BUILTIN_PUBLIC_TASK_FIELDS`), so a caller can read what to send rather than guess. The check
   * is the SAME shared rule the app's own create form and the internal API run: unknown keys,
   * wrong types, values outside a picklist and unanswered required fields are each a `422` with
   * `details.reason: 'task_type_fields_invalid'` and a `problems` list naming every one of them.
   *
   * Values are JSON-native (string, number, boolean, or a string array for a multi-select), and a
   * field the descriptor gives a DEFAULT is filled from it when omitted, so a caller restates only
   * what it actually decides.
   */
  fields: v.optional(descriptorFieldValuesSchema),
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
 * Edit a task's mutable INPUT — the external counterpart of the SPA's inline edit. Deliberately
 * narrower than the internal `updateBlock` patch (which also carries model/risk/pipeline pins and
 * board-layout knobs that have no external meaning): what a human AUTHORS, and nothing else. Every
 * field is optional; an empty patch is a harmless no-op.
 */
export const updatePublicTaskSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /**
   * The per-case values for the task's own type, keyed by field, checked against the SAME
   * descriptors `POST /services/:serviceId/tasks` validates a `fields` bag against
   * (`GET /api/v1/task-types` serves them) and refused the same way: a `422` with
   * `details.reason: 'task_type_fields_invalid'` and a `problems` list naming every problem at
   * once.
   *
   * This is what makes a REFUSED INPUT REPAIRABLE. The pre-dispatch input gate parks a run for
   * free when a task is structurally unactionable and names exactly which input is missing, and
   * four of its seven issue codes name a field of this bag: `reproduction_missing`,
   * `review_target_missing`, `success_criteria_missing` and `required_field_missing`. Until this
   * field existed the platform could accept a task, refuse to run it, say precisely what to go and
   * fix, and offer no way to fix it: the only exits were waiving the finding or deleting a task
   * whose id every stored reference points at (losing its ticket claim, which then refuses every
   * future filing of that ticket, and its attached documents). Supply the named value, then
   * `recheck` the parked run.
   *
   * **MERGED over what the task already carries, not substituted for it.** A key you send is
   * written; a key you omit keeps its stored value. That differs from the create call, where the
   * bag is all there is, and the reason is that this API does not serve the bag BACK: a task's
   * collected values are not projected onto {@link publicTaskSchema} (a deployment's own type may
   * declare a `password` field, and a read surface cannot tell those from the rest), so a
   * replacing patch would ask a caller to restate values it has no way to learn.
   *
   * Four consequences of merging, all deliberate:
   *
   * - An EMPTY value means "not supplied", exactly as at creation, so it leaves the stored value
   *   alone. There is no way to CLEAR a field over this surface; nothing needed one, and adding it
   *   later is additive where guessing at it now would not be.
   * - Only the keys you SEND are validated against the descriptors. A stored value was admitted by
   *   another authority (the internal schema these descriptors restate more narrowly, or an earlier
   *   revision of a deployment's own descriptor), and re-judging it would refuse your patch for
   *   something it did not do, identically every time: a task authored in the app with a
   *   2500-character reproduction would be permanently un-repairable here. Completeness is still
   *   judged on the RESULT, so a `required` field neither stored nor sent is named.
   * - Alternate SPELLINGS of one value supersede each other rather than merging. Sending a `review`
   *   task's `prUrl` alone repoints it; the stored `prNumber` is not merged back in beside it,
   *   which would otherwise outrank the URL and silently revert the target.
   * - The best-practice fragments a task carries are derived from these values at CREATION and are
   *   not re-derived here, matching what an edit through the app does.
   *
   * A `review` task's target is the one value with resolution behind it: the pull request is
   * verified against the provider and folded into the description, exactly as at creation, so a
   * reference this patch lands is one creation would have accepted. Sending `description` in the
   * same request is safe for a read-modify-write client: the fold this API served you is replaced,
   * not stated a second time. Where a STORED description has since been rewritten by hand the
   * platform can no longer tell which part of it was the fold, and changing the target is refused
   * (with that stated in `problems`) rather than leaving a description naming a pull request the
   * run does not review; send the description you want alongside the new target to resolve it.
   */
  fields: v.optional(descriptorFieldValuesSchema),
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
  /** Who this run was started for ({@link publicRunExternalIdentitySchema}). */
  externalIdentity: publicRunExternalIdentitySchema,
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
   * Whether this pipeline is exposed as a PUBLIC initiative pipeline (`POST /jobs`).
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

// ---------------------------------------------------------------------------
// Notification inbox (the operational loop: merge / confirm / retry).
// ---------------------------------------------------------------------------

/**
 * The external view of the workspace's OPEN notifications. Deliberately reuses the
 * SAME `notificationSchema` the SPA inbox consumes — a notification is already a small,
 * client-facing projection (no raw block / execution / credential fields), so there is
 * no separate `publicNotification` shape to keep in step. The list is naturally bounded
 * (only `open` cards, which humans resolve), unlike the paginated task/job reads.
 */
export const publicNotificationListSchema = v.object({
  notifications: v.array(notificationSchema),
})
export type PublicNotificationList = v.InferOutput<typeof publicNotificationListSchema>

// ---------------------------------------------------------------------------
// Usage & spend (the external dashboard read).
// ---------------------------------------------------------------------------

/**
 * One row of the current period's usage, aggregated in SQL over
 * `(billing, vendor, provider, model)`. A projection of the internal `UsageBreakdownRow`
 * with the same fields — it already carries no per-user, per-account or credential
 * dimension, and a usage dashboard is meaningless without the provider/model it spent on.
 */
export const publicUsageRowSchema = v.object({
  /**
   * How this usage is paid for. `metered` is real per-token cost and is what the spend
   * budget counts; `subscription` is flat-rate harness usage against a vendor plan. The two
   * are deliberately NOT summed into one number: adding an illustrative subscription figure
   * to real metered spend would report money nobody is billed for.
   */
  billing: v.picklist(['metered', 'subscription']),
  /** The subscription vendor (e.g. `claude`, `codex`) for a subscription row; null for metered. */
  vendor: v.nullable(v.string()),
  provider: v.string(),
  model: v.string(),
  /** Input tokens: fresh prompt + cache reads + cache writes, as the platform records them. */
  inputTokens: v.number(),
  outputTokens: v.number(),
  /**
   * Estimated cost in the report's `currency`. ILLUSTRATIVE on a `subscription` row (a
   * flat-rate plan bills nothing per token) — read it as "what this would have cost metered",
   * never as spend. Branch on `billing` before adding it to anything.
   */
  costEstimate: v.number(),
  /** Recorded LLM calls in this group. */
  calls: v.number(),
})
export type PublicUsageRow = v.InferOutput<typeof publicUsageRowSchema>

/**
 * The METERED spend of the current period against the workspace's budget — the numbers the
 * spend safeguard itself acts on, so an external dashboard can show the same "runs are paused"
 * state the SPA does rather than inferring it from a token count.
 *
 * Deliberately the WORKSPACE tier only. The account- and user-tier budgets
 * (`SpendService.accountStatus` / `userStatus`) are cross-workspace and per-user, so they are
 * not the key's to read: a workspace-scoped key must never learn a sibling workspace's spend.
 */
export const publicUsageBudgetSchema = v.object({
  /** Metered input tokens this period (the budgeted ones; subscription rows are excluded). */
  inputTokens: v.number(),
  outputTokens: v.number(),
  /** Estimated metered cost so far this period, in the report's `currency`. */
  costSpent: v.number(),
  /** The workspace's configured budget for one period, in the report's `currency`. */
  costLimit: v.number(),
  /** True once `costSpent >= costLimit`: runs are PAUSED until the period rolls over. */
  exceeded: v.boolean(),
})
export type PublicUsageBudget = v.InferOutput<typeof publicUsageBudgetSchema>

/**
 * The workspace's usage for the current billing period: the metered budget position plus the
 * per-model breakdown behind it. One resource rather than two endpoints because a dashboard
 * needs both together, and splitting them would let a caller render a breakdown against a
 * budget read a period-roll apart.
 *
 * `rows` is naturally bounded (distinct `(billing, vendor, provider, model)` groups within one
 * month), so it is unpaginated like the pipeline and notification lists.
 */
export const publicUsageSchema = v.object({
  /** Start of the current billing period (epoch ms; calendar month, UTC). */
  periodStart: v.number(),
  /** ISO 4217 currency every cost on this resource is expressed in. */
  currency: v.string(),
  budget: publicUsageBudgetSchema,
  rows: v.array(publicUsageRowSchema),
})
export type PublicUsage = v.InferOutput<typeof publicUsageSchema>

/**
 * What the CALLING key is, and what it may do — the answer to a question every integration has at
 * startup and could previously only get by attempting an action and reading the 403.
 *
 * Deliberately a small resource of its own rather than the `publicApiKey` row `/api/v1/keys`
 * lists: this answers "who am I", which is a fact about the request, and it must stay answerable
 * to EVERY key (a `read` one included), where listing keys is an `admin` operation. Serving the
 * row here would also publish a shape whose audience is key ADMINISTRATION, dragging revocation
 * and provenance fields into the one call an integration makes before it does anything.
 *
 * Carries no secret and no hash. The key already knows its own secret, and nothing else here
 * would be recoverable from it anyway.
 */
export const publicIdentitySchema = v.object({
  /** The `pak_*` id of the key on this request — the non-secret half of the token. */
  keyId: v.string(),
  /** The account the key belongs to. */
  accountId: v.string(),
  /** The ONE workspace every call under this key acts within. */
  workspaceId: v.string(),
  /**
   * What the key may do. The ladder is inclusive (`read` ⊂ `write` ⊂ `decide` ⊂ `admin`), so an
   * integration comparing its own scope against what it needs should test the RUNG, not equality.
   */
  scope: publicApiScopeSchema,
  /** The label the key was minted with, so a caller can log which credential it is running as. */
  label: v.string(),
  /**
   * Who this key acts for, as whoever provisioned it named them; `null` when it was minted with
   * no identity. Answered from the key on THIS request, so a provisioning integration that
   * hands a credential to a subsystem can have that subsystem discover which identity it holds
   * rather than being told twice.
   */
  externalIdentity: v.nullable(v.string()),
  /** When the key was minted (epoch ms). */
  createdAt: v.number(),
})
export type PublicIdentity = v.InferOutput<typeof publicIdentitySchema>
