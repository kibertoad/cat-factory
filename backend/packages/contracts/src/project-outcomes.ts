import * as v from 'valibot'
import {
  projectDefinitionKeySchema,
  projectDefinitionVersionSchema,
} from './project-definitions.js'

// ---------------------------------------------------------------------------
// Project outcomes: the durable results a project's work records, whatever the project's kind.
// Each outcome is one immutable revision in a named stream; the kind owns the body's shape, the
// vocabulary of `intent`, and how a stream's revisions fold into its current state. The platform
// stores, orders, sizes and reclaims revisions without reading their bodies. Design:
// `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

const slug = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,39}$/, 'must be a lowercase slug'))

/** The stream a kind writes when it declares only one. */
export const DEFAULT_OUTCOME_STREAM = 'main'

/** A named sequence of revisions within one project, e.g. `main`, `open-questions`. */
export const outcomeStreamSchema = slug

/** What the writing task asked for, in the kind's own vocabulary (research: `initial`, ...). */
export const outcomeIntentSchema = slug

/** The most artifacts one revision may reference. */
export const OUTCOME_ARTIFACT_REFS_MAX = 500

/** An outcome revision's identity and placement, without its body. */
export const projectOutcomeMetaSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  stream: outcomeStreamSchema,
  /** Per-project order across every stream, taken when the writing work STARTED. */
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  intent: outcomeIntentSchema,
  /** The version of the kind's body schema this revision was written in. */
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** The task that wrote it; null for an outcome no task produced. */
  taskId: v.nullable(v.string()),
  /** The definition the project pinned when the revision was written; null for a pinless kind. */
  definitionKey: v.nullable(projectDefinitionKeySchema),
  definitionVersion: v.nullable(projectDefinitionVersionSchema),
  /**
   * Binary artifacts the body references (screenshots, recordings), so retention and cascades
   * can find them without reading the body.
   */
  artifactRefs: v.pipe(v.array(v.string()), v.maxLength(OUTCOME_ARTIFACT_REFS_MAX)),
  createdAt: v.number(),
})
export type ProjectOutcomeMeta = v.InferOutput<typeof projectOutcomeMetaSchema>

/** An outcome revision with its body decoded by its kind. */
export interface ProjectOutcome<Body = unknown> extends ProjectOutcomeMeta {
  body: Body
}

/**
 * The schemas of a kind's own shapes: its definition `spec`, its outcome `body` and its `view`.
 * The platform never parses with them; the public API serves them as JSON Schema.
 */
export interface ProjectKindSchemas {
  spec?: v.GenericSchema
  outcome?: v.GenericSchema
  view?: v.GenericSchema
}

/** The largest inline threshold any tier may set; a facade's own row cap may be lower. */
export const OUTCOME_INLINE_MAX_BYTES_CEILING = 2_000_000
export const DEFAULT_OUTCOME_INLINE_MAX_BYTES = 256 * 1024

/**
 * One tier's outcome-storage policy. Each field is optional: absence means "inherit from the
 * wider tier", and a stored null is never written.
 */
export const outcomeStoragePolicySchema = v.object({
  inlineMaxBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(OUTCOME_INLINE_MAX_BYTES_CEILING)),
  ),
  offload: v.optional(v.picklist(['enabled', 'disabled'])),
})
export type OutcomeStoragePolicy = v.InferOutput<typeof outcomeStoragePolicySchema>

/** The tiers an outcome-storage policy is set at, narrowest last. */
export const outcomeStorageOwnerKindSchema = v.picklist(['account', 'workspace', 'project'])
export type OutcomeStorageOwnerKind = v.InferOutput<typeof outcomeStorageOwnerKindSchema>

/** Read a persisted outcome-storage policy, refusing one the schema no longer accepts. */
export function decodeOutcomeStoragePolicy(json: string): OutcomeStoragePolicy {
  const parsed = v.safeParse(outcomeStoragePolicySchema, JSON.parse(json))
  if (!parsed.success) throw new Error('stored outcome-storage policy is unreadable')
  return parsed.output
}

/** Validate a policy for writing and serialize it, so no write stores what a read refuses. */
export function encodeOutcomeStoragePolicy(policy: OutcomeStoragePolicy): string {
  const parsed = v.safeParse(outcomeStoragePolicySchema, policy)
  if (!parsed.success) throw new Error('outcome-storage policy is outside the schema')
  return JSON.stringify(parsed.output)
}

/**
 * A project task's run state, recorded on its step when the task first starts. The sequence and
 * the kind's plan are fixed then, so a replayed or resumed dispatch asks the same of the agent and
 * the outcome folds in the order the task was asked. The plan and the checkpoint are the kind's
 * own and stay `unknown` here: typing them per kind would make the workspace snapshot's type too
 * deep to instantiate, and the engine hands both back to the kind to parse.
 */
export const projectStepStateSchema = v.object({
  projectId: v.string(),
  /** The project kind whose module planned the task. */
  kind: v.string(),
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stream: outcomeStreamSchema,
  intent: outcomeIntentSchema,
  definitionKey: v.nullable(projectDefinitionKeySchema),
  definitionVersion: v.nullable(projectDefinitionVersionSchema),
  plan: v.unknown(),
  /** What the agent recorded before it stopped to wait for a credential: step state, never an outcome. */
  checkpoint: v.optional(v.unknown()),
  /** The outcome this task wrote, once written. */
  outcomeId: v.optional(v.string()),
})
export type ProjectStepState = v.InferOutput<typeof projectStepStateSchema>
