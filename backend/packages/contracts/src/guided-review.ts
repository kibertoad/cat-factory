import * as v from 'valibot'

// Guided PR review: a standalone, per-user exploration session over one pull request. It holds an
// overview of the PR, any number of question threads answered by a model with read access to the
// PR, and comment drafts the human edits and posts. Design and slice tracker:
// docs/initiatives/guided-pr-review.md.

export const GUIDED_REVIEW_QUESTION_MAX = 4000
export const GUIDED_REVIEW_ANSWER_MAX = 40_000
export const GUIDED_REVIEW_COMMENT_MAX = 8000
export const GUIDED_REVIEW_TITLE_MAX = 200
const PROSE_MAX = 8000
const PATH_MAX = 1024
const LIST_MAX = 40

const title = v.pipe(v.string(), v.maxLength(GUIDED_REVIEW_TITLE_MAX))
const prose = v.pipe(v.string(), v.maxLength(PROSE_MAX))
const path = v.pipe(v.string(), v.minLength(1), v.maxLength(PATH_MAX))
const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1))
const paths = v.pipe(v.array(path), v.maxLength(LIST_MAX))

/** Which side of the diff a line lives on: `RIGHT` is the PR head, `LEFT` the base. */
export const guidedReviewDiffSideSchema = v.picklist(['LEFT', 'RIGHT'])
export type GuidedReviewDiffSide = v.InferOutput<typeof guidedReviewDiffSideSchema>

/** A span of one file the overview or an answer points at. */
export const guidedReviewAnchorSchema = v.object({
  path,
  startLine: v.optional(lineNumber),
  endLine: v.optional(lineNumber),
  side: v.optional(guidedReviewDiffSideSchema),
})
export type GuidedReviewAnchor = v.InferOutput<typeof guidedReviewAnchorSchema>

export const guidedReviewRiskSeveritySchema = v.picklist(['low', 'medium', 'high'])
export type GuidedReviewRiskSeverity = v.InferOutput<typeof guidedReviewRiskSeveritySchema>

/**
 * The structured explanation of a PR. Every list is capped; a suggested question carries a stable
 * `id` because a client posts it back verbatim when the human clicks it.
 */
export const guidedReviewOverviewContentSchema = v.object({
  summary: prose,
  intent: prose,
  meaningfulChanges: v.pipe(
    v.array(v.object({ title, detail: prose, paths })),
    v.maxLength(LIST_MAX),
  ),
  consequences: v.pipe(v.array(v.object({ title, detail: prose })), v.maxLength(LIST_MAX)),
  risks: v.pipe(
    v.array(v.object({ title, detail: prose, severity: guidedReviewRiskSeveritySchema, paths })),
    v.maxLength(LIST_MAX),
  ),
  focusAreas: v.pipe(
    v.array(
      v.object({
        title,
        why: prose,
        anchors: v.pipe(v.array(guidedReviewAnchorSchema), v.maxLength(LIST_MAX)),
      }),
    ),
    v.maxLength(LIST_MAX),
  ),
  suggestedQuestions: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
        question: v.pipe(v.string(), v.maxLength(GUIDED_REVIEW_QUESTION_MAX)),
      }),
    ),
    v.maxLength(LIST_MAX),
  ),
})
export type GuidedReviewOverviewContent = v.InferOutput<typeof guidedReviewOverviewContentSchema>

/**
 * Lifecycle of one piece of background work (the overview, or one assistant message). `pending`
 * is queued, `running` is claimed by a driver, `complete` and `failed` are terminal.
 */
export const guidedReviewWorkStatusSchema = v.picklist(['pending', 'running', 'complete', 'failed'])
export type GuidedReviewWorkStatus = v.InferOutput<typeof guidedReviewWorkStatusSchema>

/** The non-terminal work states: the ones a driver may still claim. */
export const GUIDED_REVIEW_LIVE_STATUSES = [
  'pending',
  'running',
] as const satisfies readonly GuidedReviewWorkStatus[]

export const guidedReviewOverviewSchema = v.object({
  status: guidedReviewWorkStatusSchema,
  /** Bumped on every refresh, so a driver finishing a superseded generation cannot land it. */
  generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
  content: v.nullable(guidedReviewOverviewContentSchema),
  error: v.nullable(v.string()),
  model: v.nullable(v.string()),
})
export type GuidedReviewOverview = v.InferOutput<typeof guidedReviewOverviewSchema>

export const guidedReviewSessionSchema = v.object({
  id: v.string(),
  provider: v.picklist(['github', 'gitlab']),
  repoId: v.string(),
  owner: v.string(),
  repo: v.string(),
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  prTitle: v.string(),
  /** The PR head the overview, every answer and every draft anchor were computed against. */
  reviewedHeadSha: v.string(),
  baseRef: v.string(),
  createdBy: v.string(),
  overview: guidedReviewOverviewSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type GuidedReviewSession = v.InferOutput<typeof guidedReviewSessionSchema>

export const guidedReviewThreadSchema = v.object({
  id: v.string(),
  sessionId: v.string(),
  title: title,
  createdBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type GuidedReviewThread = v.InferOutput<typeof guidedReviewThreadSchema>

/** A thread in a session listing, with the assistant message it is waiting on, if any. */
export const guidedReviewThreadSummarySchema = v.object({
  ...guidedReviewThreadSchema.entries,
  pendingMessageId: v.nullable(v.string()),
})
export type GuidedReviewThreadSummary = v.InferOutput<typeof guidedReviewThreadSummarySchema>

/**
 * What an assistant message was asked to produce: an `answer` to the question before it, or
 * `comment-drafts` formulated from the thread so far.
 */
export const guidedReviewMessageKindSchema = v.picklist(['answer', 'comment-drafts'])
export type GuidedReviewMessageKind = v.InferOutput<typeof guidedReviewMessageKindSchema>

/**
 * How far an answer may reach: `inline` reads the PR through the VCS API; `deep` escalates to a
 * read-only checkout.
 */
export const guidedReviewDepthSchema = v.picklist(['inline', 'deep'])
export type GuidedReviewDepth = v.InferOutput<typeof guidedReviewDepthSchema>

export const guidedReviewMessageSchema = v.object({
  id: v.string(),
  threadId: v.string(),
  sessionId: v.string(),
  /** Position in the thread, 1-based and contiguous. */
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  role: v.picklist(['user', 'assistant']),
  kind: guidedReviewMessageKindSchema,
  depth: guidedReviewDepthSchema,
  content: v.pipe(v.string(), v.maxLength(GUIDED_REVIEW_ANSWER_MAX)),
  /** Always `complete` for a user message. */
  status: guidedReviewWorkStatusSchema,
  citations: v.pipe(v.array(guidedReviewAnchorSchema), v.maxLength(LIST_MAX)),
  error: v.nullable(v.string()),
  model: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type GuidedReviewMessage = v.InferOutput<typeof guidedReviewMessageSchema>

/**
 * A comment draft's lifecycle. `posting` is the atomic claim taken before the host call; `failed`
 * is re-claimable, `posted` and `discarded` are terminal.
 */
export const guidedReviewDraftStatusSchema = v.picklist([
  'proposed',
  'posting',
  'posted',
  'failed',
  'discarded',
])
export type GuidedReviewDraftStatus = v.InferOutput<typeof guidedReviewDraftStatusSchema>

export const guidedReviewCommentDraftSchema = v.object({
  id: v.string(),
  sessionId: v.string(),
  threadId: v.string(),
  /** The `comment-drafts` assistant message that proposed it. */
  messageId: v.string(),
  path,
  line: lineNumber,
  /** First line of a multi-line comment; absent for a single line. */
  startLine: v.nullable(lineNumber),
  side: guidedReviewDiffSideSchema,
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(GUIDED_REVIEW_COMMENT_MAX)),
  rationale: prose,
  status: guidedReviewDraftStatusSchema,
  /** The host's answer to the post, or why it was refused. */
  postError: v.nullable(v.string()),
  postedUrl: v.nullable(v.string()),
  /** Optimistic-concurrency token for edits. */
  rev: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type GuidedReviewCommentDraft = v.InferOutput<typeof guidedReviewCommentDraftSchema>

/**
 * Machine-readable causes a guided-review refusal carries in `details.reason`. The SPA maps each
 * to translated copy.
 */
export const GUIDED_REVIEW_REASONS = [
  'thread_busy',
  'session_stale',
  'draft_conflict',
  'draft_not_postable',
  'pr_not_found',
  'repo_not_linked',
] as const
export type GuidedReviewReason = (typeof GUIDED_REVIEW_REASONS)[number]
