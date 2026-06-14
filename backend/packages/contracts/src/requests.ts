import * as v from 'valibot'
import { agentKindSchema, blockTypeSchema, positionSchema } from './primitives'

// Request body schemas. The Hono facade validates inbound JSON against these via
// @hono/valibot-validator; the frontend API client can import the inferred input
// types to stay in lockstep with what the backend accepts.

export const createWorkspaceSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** Seed the board with the sample architecture (default true). */
  seed: v.optional(v.boolean()),
})
export type CreateWorkspaceInput = v.InferOutput<typeof createWorkspaceSchema>

export const addFrameSchema = v.object({
  type: blockTypeSchema,
  position: positionSchema,
})
export type AddFrameInput = v.InferOutput<typeof addFrameSchema>

export const addTaskSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
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

export const tickSchema = v.object({
  /** Number of simulation ticks to advance (default 1). */
  ticks: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
})
export type TickInput = v.InferOutput<typeof tickSchema>
