import * as v from 'valibot'
import {
  adhocQuestionSchema,
  findingsRevisionBodySchema,
  findingsRevisionMetaSchema,
  findingsStoragePolicySchema,
  questionFindingSchema,
  questionStatusSchema,
  researchCredentialKindSchema,
  researchDefinitionSchema,
  researchLearningSchema,
} from './research.js'

// ---------------------------------------------------------------------------
// The app's view of one research project: what it pins, its current findings, every revision
// and where its body lives, whether the credentials it declares resolve for this board, and the
// findings-storage policy tiers. The public API serves its own narrower projection.
// ---------------------------------------------------------------------------

/**
 * Where a revision's body lives. `unavailable` is an offloaded body that could not be read just
 * now: stated, so a revision whose body is missing never renders like one that is small.
 */
export const findingsRevisionStorageSchema = v.object({
  placement: v.picklist(['inline', 'offloaded']),
  bytes: v.number(),
  readable: v.boolean(),
})
export type FindingsRevisionStorage = v.InferOutput<typeof findingsRevisionStorageSchema>

export const researchRevisionEntrySchema = v.object({
  ...findingsRevisionMetaSchema.entries,
  storage: findingsRevisionStorageSchema,
})
export type ResearchRevisionEntry = v.InferOutput<typeof researchRevisionEntrySchema>

const coverageCountsSchema = v.object({
  answered: v.number(),
  partial: v.number(),
  unanswered: v.number(),
  blocked: v.number(),
})

/** One question's current answer, the revision it came from, and the attempts that kept it. */
export const researchFoldedFindingSchema = v.object({
  finding: questionFindingSchema,
  revisionId: v.string(),
  seq: v.number(),
  notes: v.array(
    v.object({
      revisionId: v.string(),
      seq: v.number(),
      status: questionStatusSchema,
      answer: v.string(),
      blockedOn: v.optional(v.object({ credentialKey: v.string() })),
    }),
  ),
})
export type ResearchFoldedFinding = v.InferOutput<typeof researchFoldedFindingSchema>

/**
 * Whether a credential the pinned definition declares resolves for this board. `reserved` names
 * a key the platform never sends to a research run, whatever is stored under it.
 */
export const researchCredentialReadinessSchema = v.object({
  key: v.string(),
  kind: researchCredentialKindSchema,
  label: v.string(),
  onboarding: v.optional(v.object({ url: v.optional(v.string()), instructions: v.string() })),
  requiredAtStart: v.boolean(),
  status: v.picklist(['stored', 'missing', 'reserved']),
})
export type ResearchCredentialReadiness = v.InferOutput<typeof researchCredentialReadinessSchema>

export const researchProjectViewSchema = v.object({
  projectId: v.string(),
  pin: v.object({
    definitionKey: v.string(),
    definitionVersion: v.number(),
    definitionHash: v.string(),
    inputs: v.record(v.string(), v.unknown()),
  }),
  /** The pinned definition, or null when it no longer resolves for the account. */
  definition: v.nullable(researchDefinitionSchema),
  /** A registered definition whose body no longer matches the pinned hash refuses to run. */
  definitionChanged: v.boolean(),
  summary: v.string(),
  latestRevisionId: v.nullable(v.string()),
  findings: v.array(researchFoldedFindingSchema),
  learnings: v.array(v.object({ ...researchLearningSchema.entries, revisionId: v.string() })),
  /** The text of every ad-hoc question a revision answered, by its `adhoc:` id. */
  adhocQuestions: v.array(adhocQuestionSchema),
  coverage: v.object({
    total: coverageCountsSchema,
    byTopic: v.array(v.object({ topicId: v.string(), counts: coverageCountsSchema })),
    adhoc: coverageCountsSchema,
    retiredQuestionIds: v.array(v.string()),
  }),
  /** Every revision, `seq` ascending. One whose body is unreadable is left out of the fold. */
  revisions: v.array(researchRevisionEntrySchema),
  credentials: v.array(researchCredentialReadinessSchema),
})
export type ResearchProjectView = v.InferOutput<typeof researchProjectViewSchema>

/** One revision with the body its task recorded. */
export const researchRevisionDetailSchema = v.object({
  ...researchRevisionEntrySchema.entries,
  body: findingsRevisionBodySchema,
})
export type ResearchRevisionDetail = v.InferOutput<typeof researchRevisionDetailSchema>

/** Each findings-storage tier as stored (null when it inherits) and the policy they resolve to. */
export const findingsStoragePolicyViewSchema = v.object({
  account: v.nullable(findingsStoragePolicySchema),
  workspace: v.nullable(findingsStoragePolicySchema),
  /** Present when the read named a project. */
  project: v.optional(v.nullable(findingsStoragePolicySchema)),
  effective: v.object({
    inlineMaxBytes: v.number(),
    offload: v.picklist(['enabled', 'disabled']),
  }),
})
export type FindingsStoragePolicyView = v.InferOutput<typeof findingsStoragePolicyViewSchema>

/** Set one tier a board may set: its own, or a project it mounts. Null clears it. */
export const setFindingsStoragePolicyInputSchema = v.variant('tier', [
  v.object({ tier: v.literal('workspace'), policy: v.nullable(findingsStoragePolicySchema) }),
  v.object({
    tier: v.literal('project'),
    projectId: v.pipe(v.string(), v.minLength(1)),
    policy: v.nullable(findingsStoragePolicySchema),
  }),
])
export type SetFindingsStoragePolicyInput = v.InferOutput<
  typeof setFindingsStoragePolicyInputSchema
>

/** Set the account tier. Null clears it. */
export const setAccountFindingsStoragePolicyInputSchema = v.object({
  policy: v.nullable(findingsStoragePolicySchema),
})
export type SetAccountFindingsStoragePolicyInput = v.InferOutput<
  typeof setAccountFindingsStoragePolicyInputSchema
>
