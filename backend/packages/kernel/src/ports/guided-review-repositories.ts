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

/** The PR facts a refresh re-reads from the host before the overview regenerates. */
export interface GuidedReviewRefresh {
  prTitle: string
  reviewedHeadSha: string
  baseRef: string
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

/** The editable fields of a comment draft. */
export type GuidedReviewDraftEdit = Partial<
  Pick<GuidedReviewCommentDraft, 'path' | 'line' | 'startLine' | 'side' | 'body'>
> & { discard?: boolean }

/** The host's answer for one claimed draft. */
export type GuidedReviewDraftPostOutcome =
  | { id: string; status: 'posted'; postedUrl: string | null }
  | { id: string; status: 'failed'; error: string }

/**
 * Which host drives a session's background work: `deployment` for the hosted engine, or
 * `node:<nodeId>` for a mothership-mode node. Recorded when work is queued so each host's sweeper
 * re-drives only its own jobs; another host would answer with the wrong model credentials.
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
   * Insert `session` unless the creator already has one for the same PR; either way, return the
   * row that is stored. Uniqueness is a database index, so two concurrent opens converge.
   */
  openSession(
    workspaceId: string,
    session: GuidedReviewSession,
    driver: GuidedReviewDriver,
  ): Promise<GuidedReviewSession>
  getSession(workspaceId: string, id: string): Promise<GuidedReviewSession | null>
  listSessions(
    workspaceId: string,
    filter: GuidedReviewSessionFilter,
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
   * `leaseCutoff`, becomes `running`. False when the generation moved or another driver holds it.
   */
  claimOverview(
    workspaceId: string,
    id: string,
    generation: number,
    leaseCutoff: number,
    now: number,
  ): Promise<boolean>
  /** Land a claimed generation's outcome. False when it is no longer the running generation. */
  settleOverview(
    workspaceId: string,
    id: string,
    generation: number,
    outcome: GuidedReviewOverviewOutcome,
    now: number,
  ): Promise<boolean>

  createThread(workspaceId: string, thread: GuidedReviewThread): Promise<void>
  getThread(workspaceId: string, id: string): Promise<GuidedReviewThread | null>
  /** The session's threads, oldest first, each with the assistant message it waits on. */
  listThreads(workspaceId: string, sessionId: string): Promise<GuidedReviewThreadSummary[]>

  /**
   * Append a user message and the assistant placeholder that will answer it, atomically. A
   * thread admits one live (pending or running) assistant message; when one exists nothing is
   * written and the result is `thread_busy`. The store assigns both `seq` values inside the same
   * write, so a caller never races another writer for a position.
   */
  appendExchange(
    workspaceId: string,
    question: Omit<GuidedReviewMessage, 'seq'>,
    placeholder: Omit<GuidedReviewMessage, 'seq'>,
    driver: GuidedReviewDriver,
  ): Promise<
    | { ok: true; question: GuidedReviewMessage; placeholder: GuidedReviewMessage }
    | { ok: false; reason: 'thread_busy' }
  >
  getMessage(workspaceId: string, id: string): Promise<GuidedReviewMessage | null>
  /** The thread's messages in `seq` order. */
  listMessages(workspaceId: string, threadId: string): Promise<GuidedReviewMessage[]>
  /** As {@link claimOverview}, for one assistant message. */
  claimMessage(workspaceId: string, id: string, leaseCutoff: number, now: number): Promise<boolean>
  /** Land a claimed message's outcome. False when it is not `running`. */
  settleMessage(
    workspaceId: string,
    id: string,
    outcome: GuidedReviewMessageOutcome,
    now: number,
  ): Promise<boolean>

  /**
   * Store the drafts a `comment-drafts` message produced and settle that message `complete`, in
   * one atomic write. False (and nothing written) when the message is not `running`.
   */
  settleDrafts(
    workspaceId: string,
    messageId: string,
    drafts: GuidedReviewCommentDraft[],
    outcome: Extract<GuidedReviewMessageOutcome, { status: 'complete' }>,
    now: number,
  ): Promise<boolean>
  getDraft(workspaceId: string, id: string): Promise<GuidedReviewCommentDraft | null>
  listDrafts(workspaceId: string, sessionId: string): Promise<GuidedReviewCommentDraft[]>
  /**
   * Apply a human edit when the draft is still at `expectedRev` and editable (`proposed` or
   * `failed`). Returns the updated draft, or null when the rev moved or the draft is not editable.
   */
  editDraft(
    workspaceId: string,
    id: string,
    expectedRev: number,
    edit: GuidedReviewDraftEdit,
    now: number,
  ): Promise<GuidedReviewCommentDraft | null>
  /**
   * Move the named drafts of a session from `proposed` or `failed` to `posting`. Returns the
   * drafts this call claimed; a draft already claimed, posted or discarded is left out.
   */
  claimDraftsForPost(
    workspaceId: string,
    sessionId: string,
    ids: string[],
    now: number,
  ): Promise<GuidedReviewCommentDraft[]>
  /** Record the host's answer for drafts this caller holds in `posting`. */
  settleDraftPosts(
    workspaceId: string,
    outcomes: GuidedReviewDraftPostOutcome[],
    now: number,
  ): Promise<void>

  /** `driver`'s background work, across every workspace, not settled since `cutoff`, oldest first. */
  listStaleJobs(
    driver: GuidedReviewDriver,
    cutoff: number,
    limit: number,
  ): Promise<GuidedReviewStaleJob[]>
}
