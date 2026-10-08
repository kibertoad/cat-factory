import * as v from 'valibot'
import { booleanQuerySchema, pageLimitSchema } from './public-paging.js'
import { vcsProviderSchema } from './routes/auth.js'

// Guided PR review: a standalone, per-user exploration session over one pull request. It holds an
// overview of the PR, any number of question threads answered by a model with read access to the
// PR, and comment drafts the human edits and posts. Design and slice tracker:
// backend/docs/adr/0066-guided-pr-review.md.

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

/**
 * Why a piece of background work failed. The SPA translates `reason`; `detail` is the raw cause
 * (a provider error, a parse failure) shown behind a disclosure.
 */
export const GUIDED_REVIEW_FAILURE_REASONS = [
  'budget_exhausted',
  'model_unavailable',
  'repo_unavailable',
  'generation_failed',
  'unreadable_reply',
  'depth_unavailable',
  /** The PR's head moved past the reviewed commit; a refresh re-points the session. */
  'head_moved',
] as const
export type GuidedReviewFailureReason = (typeof GUIDED_REVIEW_FAILURE_REASONS)[number]

export const guidedReviewFailureSchema = v.object({
  reason: v.picklist(GUIDED_REVIEW_FAILURE_REASONS),
  detail: v.nullable(v.pipe(v.string(), v.maxLength(PROSE_MAX))),
})
export type GuidedReviewFailure = v.InferOutput<typeof guidedReviewFailureSchema>

export const guidedReviewOverviewSchema = v.object({
  status: guidedReviewWorkStatusSchema,
  /** Bumped on every refresh, so a driver finishing a superseded generation cannot land it. */
  generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
  content: v.nullable(guidedReviewOverviewContentSchema),
  failure: v.nullable(guidedReviewFailureSchema),
  model: v.nullable(v.string()),
})
export type GuidedReviewOverview = v.InferOutput<typeof guidedReviewOverviewSchema>

export const guidedReviewSessionSchema = v.object({
  id: v.string(),
  provider: vcsProviderSchema,
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

/** Why a proposed comment was not kept as a draft. */
export const guidedReviewDroppedDraftReasonSchema = v.picklist([
  /** The line is not inside a diff hunk on that side, so the host would refuse the comment. */
  'outside_diff',
  /** The path is not a file the PR changes. */
  'not_in_pr',
  /** The proposal was missing a path, a line or a body. */
  'incomplete',
])
export type GuidedReviewDroppedDraftReason = v.InferOutput<
  typeof guidedReviewDroppedDraftReasonSchema
>

/**
 * What a `comment-drafts` message produced: how many comments the model proposed, and each one
 * that was refused and why, so a dropped proposal is reported rather than silently lost.
 */
export const guidedReviewDraftReportSchema = v.object({
  proposed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  dropped: v.pipe(
    v.array(
      v.object({
        path: v.string(),
        line: v.nullable(v.number()),
        side: guidedReviewDiffSideSchema,
        reason: guidedReviewDroppedDraftReasonSchema,
      }),
    ),
    v.maxLength(LIST_MAX),
  ),
})
export type GuidedReviewDraftReport = v.InferOutput<typeof guidedReviewDraftReportSchema>

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
  failure: v.nullable(guidedReviewFailureSchema),
  /** Present on a settled `comment-drafts` message. */
  draftReport: v.nullable(guidedReviewDraftReportSchema),
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
 * How long a post holds the drafts it claimed. A `posting` draft older than this lost its poster
 * before the host's answer was recorded, so another post may claim it again.
 */
export const GUIDED_REVIEW_POST_LEASE_MS = 10 * 60_000

/**
 * Whether a post may claim `draft` at `now`: a `proposed` or `failed` draft, or a `posting` one
 * whose claim has outlived {@link GUIDED_REVIEW_POST_LEASE_MS}. The server claims by this rule and
 * the review window offers a draft for posting by it, so a stranded draft stays reachable.
 */
export function isPostableDraft(
  draft: Pick<GuidedReviewCommentDraft, 'status' | 'updatedAt'>,
  now: number,
): boolean {
  if (draft.status === 'proposed' || draft.status === 'failed') return true
  return draft.status === 'posting' && draft.updatedAt < now - GUIDED_REVIEW_POST_LEASE_MS
}

/** Parse a model-shaped overview against the contract; null when it does not conform. */
export function parseGuidedReviewOverviewContent(
  input: unknown,
): GuidedReviewOverviewContent | null {
  const parsed = v.safeParse(guidedReviewOverviewContentSchema, input)
  return parsed.success ? parsed.output : null
}

/** Parse one model-shaped anchor against the contract; null when it does not conform. */
export function parseGuidedReviewAnchor(input: unknown): GuidedReviewAnchor | null {
  const parsed = v.safeParse(guidedReviewAnchorSchema, input)
  return parsed.success ? parsed.output : null
}

/** A session with its threads and drafts: what the review window loads. */
export const guidedReviewSessionViewSchema = v.object({
  session: guidedReviewSessionSchema,
  threads: v.array(guidedReviewThreadSummarySchema),
  drafts: v.array(guidedReviewCommentDraftSchema),
})
export type GuidedReviewSessionView = v.InferOutput<typeof guidedReviewSessionViewSchema>

/** A thread with its messages in order: what one tab loads. */
export const guidedReviewThreadViewSchema = v.object({
  thread: guidedReviewThreadSchema,
  messages: v.array(guidedReviewMessageSchema),
})
export type GuidedReviewThreadView = v.InferOutput<typeof guidedReviewThreadViewSchema>

/** The two messages a question appends: the question, and the placeholder that will answer it. */
export const guidedReviewExchangeSchema = v.object({
  question: guidedReviewMessageSchema,
  placeholder: guidedReviewMessageSchema,
})
export type GuidedReviewExchange = v.InferOutput<typeof guidedReviewExchangeSchema>

const questionContent = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(GUIDED_REVIEW_QUESTION_MAX),
)

export const openGuidedReviewSchema = v.object({
  owner: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  repo: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  provider: v.optional(vcsProviderSchema),
})
export type OpenGuidedReviewInput = v.InferOutput<typeof openGuidedReviewSchema>

export const askGuidedReviewSchema = v.object({
  content: questionContent,
  depth: v.optional(guidedReviewDepthSchema),
})
export type AskGuidedReviewInput = v.InferOutput<typeof askGuidedReviewSchema>

export const openGuidedReviewThreadSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(GUIDED_REVIEW_TITLE_MAX))),
  question: v.optional(askGuidedReviewSchema),
})
export type OpenGuidedReviewThreadInput = v.InferOutput<typeof openGuidedReviewThreadSchema>

export const requestGuidedReviewDraftsSchema = v.object({
  /** Narrows which comments the reviewer wants; empty asks for every conclusion. */
  instructions: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(GUIDED_REVIEW_QUESTION_MAX))),
})
export type RequestGuidedReviewDraftsInput = v.InferOutput<typeof requestGuidedReviewDraftsSchema>

export const listGuidedReviewsQuerySchema = v.object({
  repoId: v.optional(v.pipe(v.string(), v.maxLength(200))),
  prNumber: v.optional(v.pipe(v.string(), v.regex(/^\d+$/), v.transform(Number))),
  /** `true` lists only the caller's own sessions. */
  mine: v.optional(
    v.pipe(
      v.picklist(['true', 'false']),
      v.transform((s) => s === 'true'),
    ),
  ),
})

/**
 * What changed in a guided review, pushed live. It carries ids only: a client refetches the
 * session or thread it has open, so a workspace member who is not viewing it learns nothing more
 * than that it moved.
 */
export type GuidedReviewChange =
  /**
   * `session`: the overview, the session itself, or a draft a human edited or posted moved.
   * `deleted`: the session is gone.
   */
  | { sessionId: string; scope: 'session' | 'deleted' }
  /**
   * `thread`: one thread's messages moved. `drafts`: a thread's message settled with comment
   * drafts, so the session's drafts moved too.
   */
  | { sessionId: string; scope: 'thread' | 'drafts'; threadId: string }

/** Query of the public session list: the most recently updated sessions first. */
export const listPublicGuidedReviewsQuerySchema = v.object({
  ...listGuidedReviewsQuerySchema.entries,
  /** `true` lists only sessions the calling key's identity owns. */
  mine: v.optional(booleanQuerySchema),
  limit: v.optional(pageLimitSchema),
})

/** A page of sessions. `truncated` says more matched than `limit` returned. */
export const publicGuidedReviewListSchema = v.object({
  sessions: v.array(guidedReviewSessionSchema),
  truncated: v.boolean(),
})
export type PublicGuidedReviewList = v.InferOutput<typeof publicGuidedReviewListSchema>

/**
 * A human edit of a draft. `rev` is the draft's revision the edit was made against; a draft that
 * moved since is refused as `draft_conflict` rather than overwritten.
 */
export const editGuidedReviewDraftSchema = v.object({
  rev: v.pipe(v.number(), v.integer(), v.minValue(1)),
  path: v.optional(path),
  line: v.optional(lineNumber),
  startLine: v.optional(v.nullable(lineNumber)),
  side: v.optional(guidedReviewDiffSideSchema),
  body: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(GUIDED_REVIEW_COMMENT_MAX)),
  ),
  /** `true` drops the draft; a discarded draft cannot be posted or edited again. */
  discard: v.optional(v.boolean()),
})
export type EditGuidedReviewDraftInput = v.InferOutput<typeof editGuidedReviewDraftSchema>

/** Post the named drafts as one review, optionally with a summary comment. */
export const postGuidedReviewDraftsSchema = v.object({
  draftIds: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.minLength(1),
    v.maxLength(LIST_MAX),
  ),
  /** Posts only alongside a draft this call claims, so an identical retry publishes nothing. */
  summary: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(GUIDED_REVIEW_COMMENT_MAX))),
})
export type PostGuidedReviewDraftsInput = v.InferOutput<typeof postGuidedReviewDraftsSchema>

/**
 * What a post did. Each comment posts on its own, so a partial post is a normal outcome: every
 * named draft is `posted`, `failed` (with `postError`, re-postable) or was not claimed because it
 * was already posted, discarded or being posted.
 */
export const guidedReviewPostResultSchema = v.object({
  drafts: v.array(guidedReviewCommentDraftSchema),
  posted: v.pipe(v.number(), v.integer(), v.minValue(0)),
  failed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Drafts named in the request that this post did not claim. */
  skipped: v.array(v.string()),
  summary: v.object({
    /** null when no summary was sent. */
    posted: v.nullable(v.boolean()),
    error: v.nullable(v.string()),
  }),
})
export type GuidedReviewPostResult = v.InferOutput<typeof guidedReviewPostResultSchema>

/**
 * What a deep investigation container returns: the answer and the spans it rests on. Lenient on
 * citations, because a usable answer with one malformed citation is still an answer.
 */
export const guidedReviewInvestigationOutputSchema = v.object({
  answer: v.pipe(v.string(), v.maxLength(GUIDED_REVIEW_ANSWER_MAX)),
  citations: v.optional(v.array(v.unknown()), []),
})
export type GuidedReviewInvestigationOutput = v.InferOutput<
  typeof guidedReviewInvestigationOutputSchema
>
