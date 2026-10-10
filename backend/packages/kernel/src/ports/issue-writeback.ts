import type { Block, PullRequestRef, TaskSourceKind } from '../domain/types.js'

/** One open finding of a parked review, as rendered onto a tracker issue. */
export interface ReviewQuestionFinding {
  /** The review item's stable id — rendered verbatim so an answer can name it. */
  id: string
  /** Short headline of the concern. */
  title: string
  /** The full question / gap, in plain prose. */
  detail: string
}

/**
 * Which iterative review a question post (and the reply that answers it) belongs to.
 *
 * A CLOSED vocabulary rather than a free string, because both halves of the loop key off it: the
 * engine picks which runs get the echo, the provider picks whether the workspace's opt-in gates
 * it, and the renderers pick which decision route the comment names. Every one of those is an
 * exhaustive read of {@link REVIEW_QUESTION_POLICIES}, so a third subject cannot ship half-wired.
 *
 * The two brainstorm dialogues are deliberately absent: a brainstorm converges on a DIRECTION
 * rather than answering questions a reporter filed, and a block running one has no linked issue
 * whose author asked for it.
 */
export type ReviewQuestionSubject = 'requirements' | 'clarity'

/** How one review subject's question echo behaves — see {@link REVIEW_QUESTION_POLICIES}. */
export interface ReviewQuestionPolicy {
  /**
   * Which runs get the echo. `headless` posts only for a run whose requester is not in the app
   * (`isHeadlessIntake`); `every-run` posts for a UI-started run too.
   */
  audience: 'headless' | 'every-run'
  /**
   * Whether the workspace's `writebackQuestionsOnPark` setting (with the per-task
   * `Block.trackerQuestionsOnPark` override) has to be ON for the echo to fire.
   */
  optIn: boolean
}

/**
 * What each review subject's echo is FOR, which is what decides its audience and its gating.
 *
 * The two differ because the two loops differ, and collapsing them would break one of them:
 *
 * - **requirements** is the headless clarification loop. A UI-started task has a perfectly good
 *   in-app surface, so the echo exists only for a requester who is not in the app, and posting
 *   onto someone's tracker is opt-in.
 * - **clarity** is bug-report triage, and asking the REPORTER for the detail needed to fix their
 *   bug is intake semantics, not a courtesy: it fires for every run and is ungated, exactly as it
 *   did when it had its own bespoke echo.
 *
 * A `Record` over the closed union rather than two branches at the call sites, so adding a subject
 * fails to compile until someone answers both questions for it.
 */
export const REVIEW_QUESTION_POLICIES: Record<ReviewQuestionSubject, ReviewQuestionPolicy> = {
  requirements: { audience: 'headless', optIn: true },
  clarity: { audience: 'every-run', optIn: false },
}

/**
 * A parked review's open findings, ready to be posted onto the block's linked tracker
 * issue(s). Built by the engine (which owns the run's intake origin and the review) and
 * handed to the provider, which resolves the workspace's writeback settings, the linked
 * issues, and the per-issue idempotency marker.
 */
export interface ReviewQuestionPost {
  /**
   * Which review these findings belong to. Drives the provider's gating, the comment's copy and
   * the decision route it names; it is NOT part of the idempotency key, because a review id
   * already identifies exactly one review in exactly one store.
   */
  subject: ReviewQuestionSubject
  /** The parked review's id — half of the idempotency key. */
  reviewId: string
  /** The review's iteration number — the other half, so each pass posts exactly once. */
  iteration: number
  /** The review's iteration cap, rendered so a reader knows how many passes remain. */
  maxIterations: number
  /** The open findings. Never empty (the engine skips the call when there are none). */
  findings: ReviewQuestionFinding[]
  /** The run whose park these findings belong to — named so an answer can address it. */
  runId: string
}

/** What a {@link IssueWritebackProvider.postReviewQuestions} call actually did. */
export interface ReviewQuestionPostOutcome {
  /** Linked issues this iteration's comment was posted onto just now. */
  posted: number
  /** Linked issues that already carried this iteration's comment (a driver replay). */
  skipped: number
  /** Linked issues whose post failed — the park is still discoverable in-app. */
  failed: number
}

// Issue-tracker writeback port. As a task's PR progresses, the execution engine
// asks this provider to write back to the task's linked tracker issue(s): post a
// comment when the PR opens, and comment + close the issue as resolved when the PR
// merges. The concrete provider resolves the workspace's writeback settings (with
// the per-task override on the block), finds the linked issues via the task
// projection, and dispatches per source (GitHub Issues / Jira).
//
// Every method is best-effort: the engine calls them fire-and-forget so a tracker
// outage never fails a run. A provider that finds writeback disabled (workspace
// off and no task override) or no linked issues simply does nothing.

export interface IssueWritebackProvider {
  /** A task's implementation PR just opened — comment on its linked tracker issue(s). */
  onPullRequestOpened(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /** A task's PR merged — comment + close its linked tracker issue(s) as resolved. */
  onPullRequestMerged(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /**
   * The recurring `bug-intake` step just picked the block's linked issue up —
   * post a "taken by cat-factory" comment (with the run/board link when given)
   * and mark the issue in-progress: the vendor's in-progress workflow transition
   * (Jira in-progress status category / Linear `started` state), or for GitHub —
   * which has no native status — apply `inProgressLabel` (default `in-progress`),
   * creating the label if absent. Unlike the PR hooks this is NOT gated on the
   * workspace writeback settings: the pickup mark is intake semantics (the whole
   * point is claiming the issue where it was filed), not an optional courtesy.
   */
  onIssuePickedUp(
    workspaceId: string,
    blockId: string,
    info: { runUrl?: string; inProgressLabel?: string },
  ): Promise<void>
  /**
   * A run's iterative review parked with open findings — post them, each with its stable finding
   * id, onto the block's linked tracker issue(s) so the loop is answerable from where the work
   * was requested.
   *
   * ONE method for both subjects ({@link ReviewQuestionSubject}), where the clarity gate used to
   * have a bespoke echo of its own that posted bare question STRINGS. That echo was unanswerable
   * by construction: the reply grammar in
   * `backend/docs/adr/0032-tracker-webhook-intake.md` addresses a finding by id, and a comment
   * that renders no ids gives a reporter nothing to name. The findings always HAD ids (both
   * reviews persist the same item shape); only the rendering dropped them.
   *
   * What still differs by subject is WHO gets the echo and whether the workspace has to opt in,
   * and that is read off {@link REVIEW_QUESTION_POLICIES} rather than branched here: the engine
   * applies the audience half, the provider the opt-in half. The engine has already established
   * that this run qualifies and that the review has open findings; the provider owns the settings
   * read, the linked-issue lookup, and the per-`(review, iteration, issue)` idempotency marker
   * that keeps a durable-driver replay from double-posting.
   *
   * Best-effort per issue like every other hook, but NOT silent: the returned outcome
   * reports what was posted, skipped as already-posted, and failed, so the caller can log a
   * tracker outage rather than leaving it invisible.
   */
  postReviewQuestions(
    workspaceId: string,
    block: Block,
    post: ReviewQuestionPost,
  ): Promise<ReviewQuestionPostOutcome>
  /**
   * A reporter answered {@link postReviewQuestions}' findings IN THE TICKET — acknowledge what
   * the reply did, on the very issue it arrived on.
   *
   * This is the closing half of the ticket loop: without it a reporter who answered two of three
   * findings has no way to learn that the third is still holding the run, and a reply that named
   * an unknown id or landed after the review settled looks identical to one that worked. So the
   * ack always states the disposition — what was applied, what is still outstanding, and what was
   * rejected and why (see D6 of `backend/docs/adr/0032-tracker-webhook-intake.md`).
   *
   * Targeted at ONE issue (`source`/`externalId`) rather than the block's whole linked set: the
   * reply came from a specific thread, and broadcasting the ack to sibling issues would answer
   * people who never asked. Ungated by the workspace writeback settings — a reply is an explicit
   * request for a response, not a courtesy — and best-effort like every other hook: the answer is
   * already applied and settled before this is attempted, so a tracker outage costs the ack, never
   * the reply.
   *
   * An UNAUTHORIZED reply never reaches this method. Replying to one would confirm the hook exists
   * and hand an attacker an oracle, so it is dropped silently at ingest.
   */
  postReviewReplyAck(
    workspaceId: string,
    issue: { source: TaskSourceKind; externalId: string },
    ack: ReviewReplyAck,
  ): Promise<void>
}

/** How a ticket reply's command was disposed of, when it could not be applied. */
export interface ReviewReplyRejection {
  /** The command line as written, capped + scrubbed before it is echoed back. */
  command: string
  /** Why it did not apply, in plain prose (`unknown finding id`, `unknown command`, …). */
  reason: string
}

/**
 * The disposition of one ticket reply, rendered back onto the issue it arrived on.
 *
 * `outcome` is what the RUN did, which is the part a reporter actually cares about and the part
 * they cannot see from the tracker:
 *
 * - `incorporating` — nothing is open any more, so the answers were folded in and the run is
 *   re-reviewing on its own.
 * - `awaiting` — the answers landed but findings remain open; the run is still parked.
 * - `exceeded` — the review hit its iteration cap; the reply's options are `proceed` / `stop` /
 *   `extra-round` and the run stays parked until one is chosen (there is deliberately no timed
 *   auto-proceed — see D6).
 * - `settled` — the review had already moved on before the reply arrived, so nothing was applied.
 * - `resolved` — a `proceed` / `stop` / `extra-round` command settled the park outright.
 */
export interface ReviewReplyAck {
  /**
   * Which review the reply reached. The ack's copy and the reply route it points at both differ
   * by subject, and a reporter answering a bug-triage question must not be told the REQUIREMENTS
   * are being folded in.
   */
  subject: ReviewQuestionSubject
  /** The review the reply was applied to (or would have been, when `settled`). */
  reviewId: string
  /** The run whose park this reply answered — named so a reader can find it. */
  runId: string
  outcome: 'incorporating' | 'awaiting' | 'exceeded' | 'settled' | 'resolved'
  /** Findings this reply answered, by stable id. */
  answered: string[]
  /** Findings this reply dismissed, by stable id. */
  dismissed: string[]
  /** Findings still open AFTER the reply — what the reporter must still answer. */
  outstanding: ReviewQuestionFinding[]
  /** Commands that could not be applied. Never silently dropped (D4). */
  rejected: ReviewReplyRejection[]
}
