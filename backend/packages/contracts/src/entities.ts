import * as v from 'valibot'
import {
  agentKindSchema,
  agentStateSchema,
  blockLevelSchema,
  blockStatusSchema,
  blockTypeSchema,
  positionSchema,
} from './primitives'

// ---------------------------------------------------------------------------
// Entity schemas: the single source of truth for the data shapes that travel
// over the wire. Domain types in @cat-factory/core are derived from these, and
// the worker validates responses against them, so frontend, core and facade can
// never silently drift apart.
// ---------------------------------------------------------------------------

export const blockSchema = v.object({
  id: v.string(),
  title: v.string(),
  type: blockTypeSchema,
  description: v.string(),
  position: positionSchema,
  status: blockStatusSchema,
  progress: v.number(),
  dependsOn: v.array(v.string()),
  executionId: v.nullable(v.string()),
  level: blockLevelSchema,
  parentId: v.nullable(v.string()),
  confidence: v.optional(v.number()),
  confidenceThreshold: v.optional(v.number()),
  moduleName: v.optional(v.string()),
  features: v.optional(v.array(v.string())),
})
export type Block = v.InferOutput<typeof blockSchema>

export const pipelineSchema = v.object({
  id: v.string(),
  name: v.string(),
  agentKinds: v.array(agentKindSchema),
})
export type Pipeline = v.InferOutput<typeof pipelineSchema>

export const decisionSchema = v.object({
  id: v.string(),
  question: v.string(),
  options: v.array(v.string()),
  chosen: v.nullable(v.string()),
})
export type Decision = v.InferOutput<typeof decisionSchema>

export const pipelineStepSchema = v.object({
  agentKind: agentKindSchema,
  state: agentStateSchema,
  progress: v.number(),
  decision: v.nullable(decisionSchema),
  /** Text the agent produced for this step (when LLM execution is enabled). */
  output: v.optional(v.string()),
  /** Identifier of the model that produced `output`, for transparency. */
  model: v.optional(v.string()),
})
export type PipelineStep = v.InferOutput<typeof pipelineStepSchema>

export const executionStatusSchema = v.picklist(['running', 'blocked', 'done'])
export type ExecutionStatus = v.InferOutput<typeof executionStatusSchema>

export const executionInstanceSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  pipelineId: v.string(),
  pipelineName: v.string(),
  steps: v.array(pipelineStepSchema),
  currentStep: v.number(),
  status: executionStatusSchema,
})
export type ExecutionInstance = v.InferOutput<typeof executionInstanceSchema>

export const workspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  createdAt: v.number(),
})
export type Workspace = v.InferOutput<typeof workspaceSchema>

export const workspaceSnapshotSchema = v.object({
  workspace: workspaceSchema,
  blocks: v.array(blockSchema),
  pipelines: v.array(pipelineSchema),
  executions: v.array(executionInstanceSchema),
  /**
   * How runs advance: 'workflow' (durable, server-driven) or 'tick' (the client
   * drives progress by polling). Attached by the worker; optional so the core
   * snapshot builder need not know the deployment's execution mode.
   */
  executionMode: v.optional(v.picklist(['workflow', 'tick'])),
})
export type WorkspaceSnapshot = v.InferOutput<typeof workspaceSnapshotSchema>
