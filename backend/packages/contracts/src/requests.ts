import * as v from 'valibot'
import { agentConfigValuesSchema } from './agent-config.js'
import { consensusStepConfigSchema, stepGatingSchema } from './consensus.js'
import { writebackOverrideSchema } from './entities.js'
import { cloudProviderSchema, instanceSizeSchema } from './provisioning.js'
import { testEnvironmentSchema } from './testing.js'
import {
  agentKindSchema,
  blockTypeSchema,
  createTaskTypeSchema,
  positionSchema,
  sizeSchema,
  taskTypeFieldsSchema,
} from './primitives.js'

// Request body schemas. The Hono facade validates inbound JSON against these via
// @hono/valibot-validator; the frontend API client can import the inferred input
// types to stay in lockstep with what the backend accepts.

export const createWorkspaceSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** Optional free-text description shown on the board switcher / onboarding list. */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  /**
   * Seed the board with the sample architecture *blocks* (default true; the SPA
   * passes false so real boards start empty). The pipeline catalog is always
   * provisioned regardless — it is product config, not sample data.
   */
  seed: v.optional(v.boolean()),
  /**
   * The account the new board belongs to. Optional: when omitted (or in the
   * auth-disabled path) the board is created in the caller's personal account, or
   * unscoped when there is no signed-in user.
   */
  accountId: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type CreateWorkspaceInput = v.InferOutput<typeof createWorkspaceSchema>

/** Rename a board and/or update its description. */
export const renameWorkspaceSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  /** `null` clears the description; an absent key leaves it unchanged. */
  description: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(500)))),
})
export type RenameWorkspaceInput = v.InferOutput<typeof renameWorkspaceSchema>

export const addFrameSchema = v.object({
  type: blockTypeSchema,
  position: positionSchema,
})
export type AddFrameInput = v.InferOutput<typeof addFrameSchema>

/**
 * Add a service frame backed by an EXISTING GitHub repo the App can access.
 * Unlike bootstrap there is no container / agent run: the backend links + syncs
 * the repo into the workspace (if it wasn't already tracked), creates the frame
 * `ready`, and links the repo projection to it. `position` is optional — the
 * backend lays the frame out when omitted (the side-panel button passes none).
 */
export const addServiceFromRepoSchema = v.object({
  repoGithubId: v.number(),
  position: v.optional(positionSchema),
  /**
   * For a monorepo repo, the subdirectory (relative to the repo root) this service
   * lives in, e.g. `packages/api`. Omitted/empty for a whole-repo service. The
   * frame is titled after the directory's base name when given.
   */
  directory: v.optional(v.string()),
  /**
   * Whether the backing repo is a monorepo (hosts several services). Sent as part of
   * the add request instead of a separate up-front PATCH; when provided the backend
   * persists the repo's monorepo flag, then requires a {@link directory}. A monorepo
   * repo can back several service frames, each pinned to its own subdirectory.
   */
  isMonorepo: v.optional(v.boolean()),
})
export type AddServiceFromRepoInput = v.InferOutput<typeof addServiceFromRepoSchema>

export const addTaskSchema = v.object({
  // The user always names the task — no auto-generated placeholder titles.
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  // The kind of work this task represents; omitted → 'feature'. `recurring` is NOT
  // allowed here (recurring tasks are created via a recurring-pipeline schedule).
  taskType: v.optional(createTaskTypeSchema),
  // Small per-type fields collected on the form (e.g. a bug's severity / repro).
  taskTypeFields: v.optional(taskTypeFieldsSchema),
  // The merge threshold preset governing this task's auto-merge; omitted/empty →
  // the workspace default preset.
  mergePresetId: v.optional(v.pipe(v.string(), v.maxLength(120))),
  // The model preset governing which model each agent step runs on; omitted/empty →
  // the workspace default preset.
  modelPresetId: v.optional(v.pipe(v.string(), v.maxLength(120))),
  // The pipeline the task's Run controls default to; omitted/empty → none recorded.
  pipelineId: v.optional(v.pipe(v.string(), v.maxLength(120))),
  // Task-level agent-contributed config values (e.g. the Tester's environment).
  agentConfig: v.optional(agentConfigValuesSchema),
})
export type AddTaskInput = v.InferOutput<typeof addTaskSchema>

export const addModuleSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  position: v.optional(positionSchema),
})
export type AddModuleInput = v.InferOutput<typeof addModuleSchema>

export const updateBlockSchema = v.partial(
  v.object({
    title: v.pipe(v.string(), v.trim(), v.maxLength(200)),
    description: v.pipe(v.string(), v.maxLength(2000)),
    position: positionSchema,
    // The dragged frame size (service frames are resizable by their borders).
    size: sizeSchema,
    moduleName: v.pipe(v.string(), v.trim(), v.maxLength(120)),
    fragmentIds: v.array(v.pipe(v.string(), v.maxLength(120))),
    // Service-level (frame): the service's selected best-practice fragment ids (folded
    // into code-aware agents on its tasks); an empty array clears the selection.
    serviceFragmentIds: v.array(v.pipe(v.string(), v.maxLength(120))),
    // The selected model's catalog id; an empty string resets to the default.
    modelId: v.pipe(v.string(), v.maxLength(120)),
    // The merge threshold preset id; an empty string resets to the workspace default.
    mergePresetId: v.pipe(v.string(), v.maxLength(120)),
    // The model preset id; an empty string resets to the workspace default preset.
    modelPresetId: v.pipe(v.string(), v.maxLength(120)),
    // The task's default pipeline id; an empty string clears the selection.
    pipelineId: v.pipe(v.string(), v.maxLength(120)),
    // Task-level agent-contributed config values (id→value map; replaces the map).
    agentConfig: agentConfigValuesSchema,
    // Service-level (frame): docker-compose path for the Tester's local infra; an
    // empty string clears it.
    testComposePath: v.pipe(v.string(), v.maxLength(400)),
    // Service-level (frame): the service has no infra dependencies to stand up.
    noInfraDependencies: v.boolean(),
    // Service-level (frame): the default test environment tasks under this service
    // are spawned with (local docker-compose vs ephemeral); each task can override.
    defaultTestEnvironment: testEnvironmentSchema,
    // Service-level (frame): the cloud provider this service's jobs run on.
    cloudProvider: cloudProviderSchema,
    // Service-level (frame): the abstract instance size for this service's jobs.
    instanceSize: instanceSizeSchema,
    // Per-task issue-tracker writeback overrides; null clears the override (inherit
    // the workspace setting). 'on'/'off' force the behaviour for this task.
    trackerCommentOnPrOpen: v.nullable(writebackOverrideSchema),
    trackerResolveOnMerge: v.nullable(writebackOverrideSchema),
  }),
)
export type UpdateBlockInput = v.InferOutput<typeof updateBlockSchema>

export const moveBlockSchema = v.object({ position: positionSchema })
export type MoveBlockInput = v.InferOutput<typeof moveBlockSchema>

export const reparentSchema = v.object({
  parentId: v.pipe(v.string(), v.minLength(1)),
  position: positionSchema,
})
export type ReparentInput = v.InferOutput<typeof reparentSchema>

export const toggleDependencySchema = v.object({
  sourceId: v.pipe(v.string(), v.minLength(1)),
})
export type ToggleDependencyInput = v.InferOutput<typeof toggleDependencySchema>

export const createPipelineSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  agentKinds: v.pipe(v.array(agentKindSchema), v.minLength(1)),
  /**
   * Per-step human approval gates, parallel to {@link agentKinds}. Optional;
   * omitted means no gates (the pipeline runs straight through).
   */
  gates: v.optional(v.array(v.boolean())),
  /**
   * Per-step companion quality thresholds (0..1), parallel to {@link agentKinds}.
   * Only meaningful on companion steps; `null`/omitted means "use the companion's
   * default threshold". Optional.
   */
  thresholds: v.optional(v.array(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))))),
  /**
   * Per-step enable flags, parallel to {@link agentKinds}. `false` keeps the step in
   * the pipeline but skips it at run start. Optional; omitted means every step runs.
   */
  enabled: v.optional(v.array(v.boolean())),
  /**
   * Per-step consensus configs, parallel to {@link agentKinds}: a step whose kind carries
   * a consensus capability trait may run through the multi-model consensus mechanism.
   * `null`/omitted ⇒ the standard single-actor agent. Optional.
   */
  consensus: v.optional(v.array(v.nullable(consensusStepConfigSchema))),
  /**
   * Per-step estimate gating, parallel to {@link agentKinds}: an enabled entry makes the
   * step run only when the task estimate meets the threshold. `null`/omitted ⇒ always run.
   * A pipeline with any enabled gating requires a `task-estimator` step earlier in the
   * chain or it is rejected. Optional.
   */
  gating: v.optional(v.array(v.nullable(stepGatingSchema))),
  /** Free-form organizational labels for the library. Optional. */
  labels: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)))),
})
export type CreatePipelineInput = v.InferOutput<typeof createPipelineSchema>

/**
 * Edit an existing (non-built-in) pipeline. Every field is optional — only the
 * supplied fields change; `agentKinds` (when present) replaces the whole chain and
 * re-aligns the parallel arrays. Built-in pipelines reject this (clone them first).
 */
export const updatePipelineSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  agentKinds: v.optional(v.pipe(v.array(agentKindSchema), v.minLength(1))),
  gates: v.optional(v.array(v.boolean())),
  thresholds: v.optional(v.array(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))))),
  enabled: v.optional(v.array(v.boolean())),
  consensus: v.optional(v.array(v.nullable(consensusStepConfigSchema))),
  gating: v.optional(v.array(v.nullable(stepGatingSchema))),
  labels: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)))),
})
export type UpdatePipelineInput = v.InferOutput<typeof updatePipelineSchema>

/** Clone any pipeline (built-in or custom) into a new, editable copy. */
export const clonePipelineSchema = v.object({
  /** Name for the copy. Optional; defaults to "<source name> (copy)". */
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
})
export type ClonePipelineInput = v.InferOutput<typeof clonePipelineSchema>

/**
 * Organize a pipeline in the library: set labels and/or archive state. The ONLY
 * mutation allowed on a built-in pipeline (it touches view/organization metadata,
 * not structure), so built-ins can be tagged/archived while staying read-only for
 * their steps. Every field optional — only the supplied fields change.
 */
export const organizePipelineSchema = v.object({
  labels: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40)))),
  archived: v.optional(v.boolean()),
})
export type OrganizePipelineInput = v.InferOutput<typeof organizePipelineSchema>

export const startExecutionSchema = v.object({
  pipelineId: v.pipe(v.string(), v.minLength(1)),
})
export type StartExecutionInput = v.InferOutput<typeof startExecutionSchema>

// NOTE: the personal password that unlocks a run's individual-usage credential
// (Claude / GLM / Codex) is NOT a body field on any of the run endpoints below
// (start / retry / resolve-decision / approve / request-changes). It is an ambient
// credential carried on the `X-Personal-Password` header (see
// `PERSONAL_PASSWORD_HEADER` in personal-subscriptions.ts), so it stays out of the
// wire-contract payloads and the client can attach it uniformly on the gated calls.

export const resolveDecisionSchema = v.object({
  choice: v.pipe(v.string(), v.minLength(1)),
})
export type ResolveDecisionInput = v.InferOutput<typeof resolveDecisionSchema>

/**
 * Approve a step's gated proposal. An optional edited `proposal` overrides the
 * agent's text, so the human's revision is what flows to downstream steps.
 */
export const approveStepSchema = v.object({
  proposal: v.optional(v.pipe(v.string(), v.maxLength(50000))),
})
export type ApproveStepInput = v.InferOutput<typeof approveStepSchema>

/** One GitHub-review-style comment on a block of the proposal (request body). */
const reviewCommentInputSchema = v.object({
  quotedSource: v.pipe(v.string(), v.maxLength(20000)),
  srcStart: v.number(),
  srcEnd: v.number(),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(5000)),
})

/**
 * Request changes on a gated proposal: the step re-runs with the reviewer's
 * freeform `feedback` and/or per-block `comments`. At least one of the two must
 * be present — an empty review changes nothing.
 */
export const requestStepChangesSchema = v.pipe(
  v.object({
    feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(10000))),
    comments: v.optional(v.array(reviewCommentInputSchema)),
  }),
  v.check(
    (input) => Boolean(input.feedback?.length) || Boolean(input.comments?.length),
    'Provide freeform feedback or at least one comment',
  ),
)
export type RequestStepChangesInput = v.InferOutput<typeof requestStepChangesSchema>

/** Reject a gated proposal: the run stops entirely (a terminal failure). */
export const rejectStepSchema = v.object({
  reason: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
})
export type RejectStepInput = v.InferOutput<typeof rejectStepSchema>

/**
 * Restart a run from a chosen step: re-run from `fromStepIndex` onward, keeping the
 * earlier steps (and their outputs) as handoff context and resetting that step plus
 * every later one's iteration counters. The service validates the index against the
 * run's real step count; this only enforces a non-negative integer up front.
 */
export const restartFromStepSchema = v.object({
  fromStepIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type RestartFromStepInput = v.InferOutput<typeof restartFromStepSchema>
