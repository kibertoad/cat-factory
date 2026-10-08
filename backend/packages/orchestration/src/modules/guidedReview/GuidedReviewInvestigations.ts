import type {
  GuidedReviewChange,
  GuidedReviewFailure,
  GuidedReviewMessage,
  GuidedReviewSession,
} from '@cat-factory/contracts'
import type {
  Clock,
  GuidedReviewInvestigationHandle,
  GuidedReviewInvestigator,
  GuidedReviewJobProgress,
  GuidedReviewRepository,
  Logger,
} from '@cat-factory/kernel'
import { getErrorMessage, runBestEffort } from '@cat-factory/kernel'
import { coerceAnswer, GUIDED_REVIEW_LEASE_MS } from './guidedReview.logic.js'

/** How often a deep answer's container is polled, and how long it may work before it is stopped. */
export const DEEP_POLL_MS = 15_000
export const DEEP_MAX_MS = 45 * 60_000

const DONE: GuidedReviewJobProgress = { done: true }
const AGAIN: GuidedReviewJobProgress = { done: false, pollAfterMs: DEEP_POLL_MS }

export interface GuidedReviewInvestigationsDeps {
  repository: GuidedReviewRepository
  investigator: GuidedReviewInvestigator
  clock: Clock
  logger: Logger
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  requireSession: (workspaceId: string, sessionId: string) => Promise<GuidedReviewSession>
  /** The thread before `message`, rendered as the question the container answers. */
  renderPrompt: (
    workspaceId: string,
    session: GuidedReviewSession,
    message: GuidedReviewMessage,
  ) => Promise<string>
  notify: (workspaceId: string, change: GuidedReviewChange) => Promise<void>
}

/**
 * Deep guided-review answers: a read-only container per question, driven as a small state machine
 * on the message row. The claim is taken before dispatch and the dispatch is recorded after it,
 * so a replay re-addresses the same container (dispatch is idempotent per message id). Every poll
 * refreshes the claim, so a live investigation is never mistaken for a dead one, and a driver that
 * died is replaced by one that resumes polling the same container.
 */
export class GuidedReviewInvestigations {
  constructor(private readonly deps: GuidedReviewInvestigationsDeps) {}

  async run(workspaceId: string, message: GuidedReviewMessage): Promise<GuidedReviewJobProgress> {
    const { repository, clock } = this.deps
    if (message.status === 'complete' || message.status === 'failed') return DONE
    const record = await repository.getInvestigation(workspaceId, message.id)
    if (!record) {
      // Pending, or claimed by a starter that died before recording its dispatch.
      const now = clock.now()
      if (
        !(await repository.claimMessage(workspaceId, message.id, now - GUIDED_REVIEW_LEASE_MS, now))
      ) {
        return DONE
      }
      return (await this.start(workspaceId, message)) ? AGAIN : DONE
    }
    const session = await this.deps.requireSession(workspaceId, message.sessionId)
    const handle: GuidedReviewInvestigationHandle = {
      workspaceId,
      jobId: message.id,
      initiatedBy: session.createdBy,
      dispatch: record.dispatch,
    }
    if (clock.now() - record.dispatchedAt > DEEP_MAX_MS) {
      await this.release(handle)
      await this.settleFailed(
        workspaceId,
        message,
        {
          reason: 'generation_failed',
          detail: `The investigation did not finish within ${DEEP_MAX_MS / 60_000} minutes.`,
        },
        record.dispatch.model,
      )
      return DONE
    }
    const update = await this.deps.investigator.poll(handle)
    if (update.state === 'running') {
      if (await repository.heartbeatMessage(workspaceId, message.id, clock.now())) return AGAIN
      // Settled or abandoned while the container worked: nothing will read it, so reclaim it.
      await this.release(handle)
      return DONE
    }
    if (update.state === 'failed') {
      await this.settleFailed(
        workspaceId,
        message,
        {
          reason: 'generation_failed',
          detail: update.error,
        },
        record.dispatch.model,
      )
      return DONE
    }
    const answer = coerceAnswer(update.report)
    if (!answer) {
      await this.settleFailed(
        workspaceId,
        message,
        {
          reason: 'unreadable_reply',
          detail: null,
        },
        update.model,
      )
      return DONE
    }
    const landed = await repository.settleMessage(
      workspaceId,
      message.id,
      { status: 'complete', ...answer, draftReport: null, model: update.model },
      clock.now(),
    )
    if (landed) await this.notifyThread(workspaceId, message)
    return DONE
  }

  /** Reclaim a deep answer's container, if one was dispatched. Best-effort. */
  async releaseFor(workspaceId: string, message: GuidedReviewMessage): Promise<void> {
    const record = await this.deps.repository.getInvestigation(workspaceId, message.id)
    if (!record) return
    const session = await this.deps.requireSession(workspaceId, message.sessionId)
    await this.release({
      workspaceId,
      jobId: message.id,
      initiatedBy: session.createdBy,
      dispatch: record.dispatch,
    })
  }

  /** Dispatch the container and record it; null when the message was settled instead. */
  private async start(workspaceId: string, message: GuidedReviewMessage) {
    const { investigator, repository, clock } = this.deps
    if (await this.deps.isOverBudget?.(workspaceId)) {
      await this.settleFailed(
        workspaceId,
        message,
        { reason: 'budget_exhausted', detail: null },
        null,
      )
      return null
    }
    if (!(await investigator.supports(workspaceId))) {
      await this.settleFailed(
        workspaceId,
        message,
        { reason: 'depth_unavailable', detail: null },
        null,
      )
      return null
    }
    const session = await this.deps.requireSession(workspaceId, message.sessionId)
    let handle: GuidedReviewInvestigationHandle
    try {
      handle = await investigator.start({
        workspaceId,
        jobId: message.id,
        initiatedBy: session.createdBy,
        repo: { owner: session.owner, name: session.repo, provider: session.provider },
        prNumber: session.prNumber,
        baseRef: session.baseRef,
        headSha: session.reviewedHeadSha,
        userPrompt: await this.deps.renderPrompt(workspaceId, session, message),
      })
    } catch (error) {
      await this.settleFailed(
        workspaceId,
        message,
        {
          reason: 'generation_failed',
          detail: getErrorMessage(error),
        },
        null,
      )
      return null
    }
    const record = { dispatchedAt: clock.now(), dispatch: handle.dispatch }
    if (!(await repository.recordInvestigation(workspaceId, message.id, record, clock.now()))) {
      await this.release(handle)
      return null
    }
    return record
  }

  private async settleFailed(
    workspaceId: string,
    message: GuidedReviewMessage,
    failure: GuidedReviewFailure,
    model: string | null,
  ): Promise<void> {
    const landed = await this.deps.repository.settleMessage(
      workspaceId,
      message.id,
      { status: 'failed', failure, model },
      this.deps.clock.now(),
    )
    if (landed) await this.notifyThread(workspaceId, message)
  }

  private notifyThread(workspaceId: string, message: GuidedReviewMessage): Promise<void> {
    return this.deps.notify(workspaceId, {
      sessionId: message.sessionId,
      scope: 'thread',
      threadId: message.threadId,
    })
  }

  private async release(handle: GuidedReviewInvestigationHandle): Promise<void> {
    await runBestEffort(
      this.deps.logger,
      'guidedReview.releaseInvestigation',
      () => this.deps.investigator.stop(handle),
      { workspaceId: handle.workspaceId, jobId: handle.jobId },
    )
  }
}
