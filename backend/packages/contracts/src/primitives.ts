import * as v from 'valibot'

// Shared scalar schemas. Picklists mirror the frontend's `app/types/domain.ts`
// unions exactly, so a payload that validates here drops straight into the Pinia
// stores without translation.

export const blockTypeSchema = v.picklist([
  'frontend',
  'service',
  'api',
  'database',
  'queue',
  'integration',
  'external',
])
export type BlockType = v.InferOutput<typeof blockTypeSchema>

export const blockStatusSchema = v.picklist([
  'planned',
  'ready',
  'in_progress',
  'blocked',
  'pr_ready',
  'done',
])
export type BlockStatus = v.InferOutput<typeof blockStatusSchema>

export const blockLevelSchema = v.picklist(['frame', 'module', 'task'])
export type BlockLevel = v.InferOutput<typeof blockLevelSchema>

export const agentStateSchema = v.picklist(['pending', 'working', 'waiting_decision', 'done'])
export type AgentState = v.InferOutput<typeof agentStateSchema>

/** Agent kinds are an open set — custom agents get free-form ids. */
export const agentKindSchema = v.pipe(v.string(), v.minLength(1))
export type AgentKind = v.InferOutput<typeof agentKindSchema>

export const positionSchema = v.object({
  x: v.number(),
  y: v.number(),
})
export type Position = v.InferOutput<typeof positionSchema>
