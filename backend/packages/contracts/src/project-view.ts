import * as v from 'valibot'
import {
  projectCredentialKindSchema,
  projectDefinitionKeySchema,
  projectDefinitionSchema,
  projectDefinitionVersionSchema,
} from './project-definitions.js'
import { outcomeStoragePolicySchema, projectOutcomeMetaSchema } from './project-outcomes.js'
import { projectKindIdSchema } from './projects.js'

// ---------------------------------------------------------------------------
// The app's view of one project on a board, whatever its kind: what it pins, every outcome and
// where its body lives, whether the credentials its definition declares resolve for this board,
// the view its kind computes, and the outcome-storage policy tiers. The kind's `view` is opaque
// here; the SPA renders it with the reader its kind contributes, or a generic one.
// ---------------------------------------------------------------------------

/**
 * Where an outcome's body lives. `readable: false` is an offloaded body that could not be read
 * just now: stated, so an outcome whose body is missing never renders like one that is small.
 */
export const projectOutcomeStorageSchema = v.object({
  placement: v.picklist(['inline', 'offloaded']),
  bytes: v.number(),
  readable: v.boolean(),
})
export type ProjectOutcomeStorage = v.InferOutput<typeof projectOutcomeStorageSchema>

export const projectOutcomeEntrySchema = v.object({
  ...projectOutcomeMetaSchema.entries,
  storage: projectOutcomeStorageSchema,
})
export type ProjectOutcomeEntry = v.InferOutput<typeof projectOutcomeEntrySchema>

/**
 * Whether a credential the pinned definition declares resolves for this board. `reserved` names a
 * key the platform never sends to a run, whatever is stored under it.
 */
export const projectCredentialReadinessSchema = v.object({
  key: v.string(),
  kind: projectCredentialKindSchema,
  label: v.string(),
  onboarding: v.optional(v.object({ url: v.optional(v.string()), instructions: v.string() })),
  requiredAtStart: v.boolean(),
  status: v.picklist(['stored', 'missing', 'reserved']),
})
export type ProjectCredentialReadiness = v.InferOutput<typeof projectCredentialReadinessSchema>

export const projectBoardViewSchema = v.object({
  projectId: v.string(),
  kind: projectKindIdSchema,
  /** The definition the project pinned; null for a kind that pins none. */
  pin: v.nullable(
    v.object({
      definitionKey: projectDefinitionKeySchema,
      definitionVersion: projectDefinitionVersionSchema,
      definitionHash: v.string(),
      inputs: v.record(v.string(), v.unknown()),
    }),
  ),
  /** The pinned definition, or null when there is none or it no longer resolves. */
  definition: v.nullable(projectDefinitionSchema),
  /** A registered definition whose body no longer matches the pinned hash refuses to run. */
  definitionChanged: v.boolean(),
  /** Every outcome, `seq` ascending. One whose body is unreadable is left out of `view`. */
  outcomes: v.array(projectOutcomeEntrySchema),
  credentials: v.array(projectCredentialReadinessSchema),
  /** The kind's reading of every readable outcome; null for a kind that computes none. */
  view: v.unknown(),
})
export type ProjectBoardView = v.InferOutput<typeof projectBoardViewSchema>

/** One outcome with the body its task recorded, as its kind decoded it. */
export const projectOutcomeDetailSchema = v.object({
  ...projectOutcomeEntrySchema.entries,
  body: v.unknown(),
})
export type ProjectOutcomeDetail = v.InferOutput<typeof projectOutcomeDetailSchema>

/** Each outcome-storage tier as stored (null when it inherits) and the policy they resolve to. */
export const outcomeStoragePolicyViewSchema = v.object({
  account: v.nullable(outcomeStoragePolicySchema),
  workspace: v.nullable(outcomeStoragePolicySchema),
  /** Present when the read named a project. */
  project: v.optional(v.nullable(outcomeStoragePolicySchema)),
  effective: v.object({
    inlineMaxBytes: v.number(),
    offload: v.picklist(['enabled', 'disabled']),
  }),
})
export type OutcomeStoragePolicyView = v.InferOutput<typeof outcomeStoragePolicyViewSchema>

/** Set one tier a board may set: its own, or a project it mounts. Null clears it. */
export const setOutcomeStoragePolicyInputSchema = v.variant('tier', [
  v.object({ tier: v.literal('workspace'), policy: v.nullable(outcomeStoragePolicySchema) }),
  v.object({
    tier: v.literal('project'),
    projectId: v.pipe(v.string(), v.minLength(1)),
    policy: v.nullable(outcomeStoragePolicySchema),
  }),
])
export type SetOutcomeStoragePolicyInput = v.InferOutput<typeof setOutcomeStoragePolicyInputSchema>

/** Set the account tier. Null clears it. */
export const setAccountOutcomeStoragePolicyInputSchema = v.object({
  policy: v.nullable(outcomeStoragePolicySchema),
})
export type SetAccountOutcomeStoragePolicyInput = v.InferOutput<
  typeof setAccountOutcomeStoragePolicyInputSchema
>
