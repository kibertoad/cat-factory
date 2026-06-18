import * as v from 'valibot'
import { agentKindSchema, blockTypeSchema, positionSchema, testTargetSchema } from './primitives'

// Request body schemas. The Hono facade validates inbound JSON against these via
// @hono/valibot-validator; the frontend API client can import the inferred input
// types to stay in lockstep with what the backend accepts.

export const createWorkspaceSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** Seed the board with the sample architecture (default true). */
  seed: v.optional(v.boolean()),
  /**
   * The account the new board belongs to. Optional: when omitted (or in the
   * auth-disabled path) the board is created in the caller's personal account, or
   * unscoped when there is no signed-in user.
   */
  accountId: v.optional(v.pipe(v.string(), v.minLength(1))),
})
export type CreateWorkspaceInput = v.InferOutput<typeof createWorkspaceSchema>

/** Rename a board. */
export const renameWorkspaceSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
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
})
export type AddServiceFromRepoInput = v.InferOutput<typeof addServiceFromRepoSchema>

export const addTaskSchema = v.object({
  // The user always names the task — no auto-generated placeholder titles.
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
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
    confidenceThreshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    moduleName: v.pipe(v.string(), v.trim(), v.maxLength(120)),
    features: v.array(v.pipe(v.string(), v.maxLength(120))),
    fragmentIds: v.array(v.pipe(v.string(), v.maxLength(120))),
    // The selected model's catalog id; an empty string resets to the default.
    modelId: v.pipe(v.string(), v.maxLength(120)),
    // Where this block's acceptance / Playwright tests run.
    testTarget: testTargetSchema,
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
})
export type CreatePipelineInput = v.InferOutput<typeof createPipelineSchema>

export const startExecutionSchema = v.object({
  pipelineId: v.pipe(v.string(), v.minLength(1)),
})
export type StartExecutionInput = v.InferOutput<typeof startExecutionSchema>

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

/** Request changes on a gated proposal: the step re-runs with this feedback. */
export const requestStepChangesSchema = v.object({
  feedback: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
})
export type RequestStepChangesInput = v.InferOutput<typeof requestStepChangesSchema>
