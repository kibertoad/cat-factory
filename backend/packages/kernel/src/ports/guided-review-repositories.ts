import type {
  GuidedReviewCommentDraft,
  GuidedReviewDraftReport,
  GuidedReviewFailure,
  GuidedReviewMessage,
  GuidedReviewOverviewContent,
  GuidedReviewSession,
  GuidedReviewThread,
  GuidedReviewThreadSummary,
} from '../domain/types.js'

export interface GuidedReviewSessionFilter {
  repoId?: string
  prNumber?: number
  createdBy?: string
  limit?: number
}

/**
 * One keyset page of sessions, newest CREATED first, with `id` breaking ties. `cursor` is
 * exclusive on that same `(createdAt, id)` composite, so a burst of sessions sharing a millisecond
 * pages without dropping any. Creation order, never update order: an update would move an unseen
 * session ahead of the cursor and the caller would never see it.
 */
export interface GuidedReviewSessionPage {
  limit: number
  cursor?: { createdAt: number; id: string }
}

/** The PR facts a refresh re-reads from the host before the overview regenerates. */
export interface GuidedReviewRefresh {
  prTitle: string
  reviewedHeadSha: string
  baseRef: string
}

/** A session as its creator opens it; the store queues overview generation 1 itself. */
export type GuidedReviewNewSession = Omit<GuidedReviewSession, 'overview'>

/**
 * One question and the assistant placeholder that will answer it. Both land on `threadId`; the
 * store writes the question `complete` and the placeholder `pending`, so a caller cannot queue
 * work no driver can claim.
 */
export interface GuidedReviewExchange {
  sessionId: string
  threadId: string
  kind: GuidedReviewMessage['kind']
  depth: GuidedReviewMessage['depth']
  questionId: string
  question: string
  placeholderId: string
  at: number
}

/** How a terminal overview generation ended. */
export type GuidedReviewOverviewOutcome =
  | { status: 'complete'; content: GuidedReviewOverviewContent; model: string }
  | { status: 'failed'; failure: GuidedReviewFailure; model: string | null }

/** How a terminal assistant message ended. */
export type GuidedReviewMessageOutcome =
  | {
      status: 'complete'
      content: string
      citations: GuidedReviewMessage['citations']
      draftReport: GuidedReviewDraftReport | null
      model: string
    }
  | { status: 'failed'; failure: GuidedReviewFailure; model: string | null }

/**
 * A comment the model proposed, as the driver hands it to `settleDrafts`. The store supplies everything else: the session, thread and message come from the message being
 * settled, and a new draft is always `proposed` at rev 1.
 */
export type GuidedReviewDraftProposal = Pick<
  GuidedReviewCommentDraft,
  'id' | 'path' | 'line' | 'startLine' | 'side' | 'body' | 'rationale'
>

/** The editable fields of a comment draft. */
export type GuidedReviewDraftEdit = Partial<
  Pick<GuidedReviewCommentDraft, 'path' | 'line' | 'startLine' | 'side' | 'body'>
> & { discard?: boolean }

/**
 * The host's answer for one claimed draft. `rev` is the draft's rev as `claimDraftsForPost`
 * returned it: it identifies the claim, so a poster whose lease lapsed cannot record over the
 * poster that re-claimed the draft.
 */
export type GuidedReviewDraftPostOutcome =
  | { id: string; rev: number; status: 'posted'; postedUrl: string | null }
  | { id: string; rev: number; status: 'failed'; error: string }

/**
 * Proof of a won claim on an overview generation or an assistant message. A settle must present
 * it: a driver whose lease lapsed and was re-claimed by another holds a stale claim, and its
 * settle is refused instead of landing over the live one.
 */
export interface GuidedReviewClaim {
  /** The `now` the claim was taken at. A re-claim needs an expired lease, so it always differs. */
  claimedAt: number
}

/**
 * Which host drives a session's background work: `deployment` for the hosted engine, or
 * `node:<nodeId>` for a mothership-mode node. Recorded when work is queued so the deployment's
 * sweeper re-drives only `deployment` jobs; another host would answer with the wrong model
 * credentials. A node recovers its own jobs from its local durable queue, never from this scan.
 */
export type GuidedReviewDriver = string

/** A unit of background work the sweeper may have to re-drive. */
export type GuidedReviewStaleJob =
  | { kind: 'overview'; workspaceId: string; sessionId: string; generation: number }
  | { kind: 'message'; workspaceId: string; messageId: string }

/**
 * Persistence for guided PR review sessions (docs/initiatives/guided-pr-review.md). Four tables,
 * one row per message and per draft, so concurrent threads never contend on one row.
 *
 * Every state transition a driver or a second writer can race on is a CONDITIONAL write returning
 * whether it won: callers branch on the boolean and never write blind.
 */
export interface GuidedReviewRepository {
  /**
   * Insert `session` with overview generation 1 `pending`, unless the creator already has one for
   * the same PR; either way, return the row that is stored. Uniqueness is a database index, so two
   * concurrent opens converge.
   */
  openSession(
    workspaceId: string,
    session: GuidedReviewNewSession,
    driver: GuidedReviewDriver,
  ): Promise<GuidedReviewSession>
  getSession(workspaceId: string, id: string): Promise<GuidedReviewSession | null>
  listSessions(
    workspaceId: string,
    filter: GuidedReviewSessionFilter,
  ): Promise<GuidedReviewSession[]>
  /** One {@link GuidedReviewSessionPage} of the sessions matching `filter`. */
  pageSessions(
    workspaceId: string,
    filter: Omit<GuidedReviewSessionFilter, 'limit'>,
    page: GuidedReviewSessionPage,
  ): Promise<GuidedReviewSession[]>
  /** Removes the session with its threads, messages and drafts. */
  deleteSession(workspaceId: string, id: string): Promise<void>

  /**
   * Point the session at a new head and queue overview generation `expectedGeneration + 1`.
   * False when another refresh already moved the generation.
   */
  restartOverview(
    workspaceId: string,
    id: string,
    expectedGeneration: number,
    refresh: GuidedReviewRefresh,
    driver: GuidedReviewDriver,
    now: number,
  ): Promise<boolean>
  /**
   * Claim overview `generation` for a driver: `pending`, or `running` with a claim older than
   * `leaseCutoff`, becomes `running`. Null when the generation moved or another driver holds it.
   */
  claimOverview(
    workspaceId: string,
    id: string,
    generation: number,
    leaseCutoff: number,
    now: number,
  ): Promise<GuidedReviewClaim | null>
  /**
   * Land a claimed generation's outcome. False when it is no longer the running generation or
   * `claim` is no longer the claim holding it. Throws a `ValidationError`, writing nothing, when
   * the outcome is outside the `@cat-factory/contracts` schema every read decodes against.
   */
  settleOverview(
    workspaceId: string,
    id: string,
    generation: number,
    outcome: GuidedReviewOverviewOutcome,
    now: number,
    claim: GuidedReviewClaim,
  ): Promise<boolean>

  createThread(workspaceId: string, thread: GuidedReviewThread): Promise<void>
  getThread(workspaceId: string, id: string): Promise<GuidedReviewThread | null>
  /** The session's threads, oldest first, each with the assistant message it waits on. */
  listThreads(workspaceId: string, sessionId: string): Promise<GuidedReviewThreadSummary[]>

  /**
   * Append the exchange's question and placeholder atomically. A thread admits one live (pending
   * or running) assistant message; when one exists nothing is written and the result is
   * `thread_busy`. `thread_not_found` when the thread does not exist in `exchange.sessionId`. The
   * store assigns both `seq` values inside the same write, so a caller never races another writer
   * for a position.
   */
  appendExchange(
    workspaceId: string,
    exchange: GuidedReviewExchange,
    driver: GuidedReviewDriver,
  ): Promise<
    | { ok: true; question: GuidedReviewMessage; placeholder: GuidedReviewMessage }
    | { ok: false; reason: 'thread_busy' | 'thread_not_found' }
  >
  getMessage(workspaceId: string, id: string): Promise<GuidedReviewMessage | null>
  /** The thread's messages in `seq` order. */
  listMessages(workspaceId: string, threadId: string): Promise<GuidedReviewMessage[]>
  /** As {@link claimOverview}, for one assistant message. */
  claimMessage(
    workspaceId: string,
    id: string,
    leaseCutoff: number,
    now: number,
  ): Promise<GuidedReviewClaim | null>
  /**
   * Land a claimed message's outcome. False when it is not `running` under `claim`. Throws as
   * {@link settleOverview} does for an out-of-contract outcome.
   */
  settleMessage(
    workspaceId: string,
    id: string,
    outcome: GuidedReviewMessageOutcome,
    now: number,
    claim: GuidedReviewClaim,
  ): Promise<boolean>

  /**
   * Store the drafts a `comment-drafts` message produced and settle that message `complete`, in
   * one atomic write. Each draft lands `proposed` at rev 1 under `messageId` and that message's
   * session and thread. False (and nothing written) when the message is not a `running`
   * `comment-drafts` message under `claim`. Throws as {@link settleOverview} does when the outcome
   * or a proposal is out of contract.
   */
  settleDrafts(
    workspaceId: string,
    messageId: string,
    drafts: GuidedReviewDraftProposal[],
    outcome: Extract<GuidedReviewMessageOutcome, { status: 'complete' }>,
    now: number,
    claim: GuidedReviewClaim,
  ): Promise<boolean>
  getDraft(workspaceId: string, id: string): Promise<GuidedReviewCommentDraft | null>
  listDrafts(workspaceId: string, sessionId: string): Promise<GuidedReviewCommentDraft[]>
  /**
   * Apply a human edit when the draft is still at `expectedRev` and editable (`proposed` or
   * `failed`). Returns the updated draft, or null when the rev moved or the draft is not editable.
   * Throws a `ValidationError` when the edited draft would be out of contract.
   */
  editDraft(
    workspaceId: string,
    id: string,
    expectedRev: number,
    edit: GuidedReviewDraftEdit,
    now: number,
  ): Promise<GuidedReviewCommentDraft | null>
  /**
   * Move the named drafts of a session from `proposed` or `failed` to `posting`, and re-claim a
   * `posting` draft whose claim is older than `leaseCutoff`, so a poster that died between claim
   * and settle cannot strand it. Returns the drafts this call claimed; a draft held by a live
   * claim, posted or discarded is left out.
   */
  claimDraftsForPost(
    workspaceId: string,
    sessionId: string,
    ids: string[],
    leaseCutoff: number,
    now: number,
  ): Promise<GuidedReviewCommentDraft[]>
  /**
   * Record the host's answer for drafts this caller holds in `posting` at the outcome's `rev`.
   * Returns the ids recorded; an outcome whose claim was taken over is left out.
   */
  settleDraftPosts(
    workspaceId: string,
    outcomes: GuidedReviewDraftPostOutcome[],
    now: number,
  ): Promise<string[]>

  /** `driver`'s background work, across every workspace, not settled since `cutoff`, oldest first. */
  listStaleJobs(
    driver: GuidedReviewDriver,
    cutoff: number,
    limit: number,
  ): Promise<GuidedReviewStaleJob[]>
}
