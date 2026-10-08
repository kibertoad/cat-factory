import type {
  EditGuidedReviewDraftInput,
  GuidedReviewChange,
  GuidedReviewCommentDraft,
  GuidedReviewPostResult,
  GuidedReviewSession,
} from '@cat-factory/contracts'
import { GUIDED_REVIEW_POST_LEASE_MS } from '@cat-factory/contracts'
import type {
  Clock,
  CreateReviewResult,
  GitHubChangedFile,
  GuidedReviewDraftPostOutcome,
  GuidedReviewRepository,
  RepoFiles,
} from '@cat-factory/kernel'
import {
  ConflictError,
  getErrorMessage,
  hostMarkdown,
  NotFoundError,
  redactSecrets,
  ValidationError,
  VcsCapabilityUnsupportedError,
} from '@cat-factory/kernel'
import { isCommentableAnchor } from './guidedReview.logic.js'

/** What the drafts collaborator needs from the service, as bound callbacks. */
export interface GuidedReviewDraftsDeps {
  repository: GuidedReviewRepository
  clock: Clock
  /** The session, refusing anyone but its creator. */
  ownedSession: (
    workspaceId: string,
    userId: string,
    sessionId: string,
  ) => Promise<GuidedReviewSession>
  /** The PR's repository, bound for reading and posting. */
  repoOf: (workspaceId: string, session: GuidedReviewSession) => Promise<RepoFiles>
  /** Run a VCS call under the credential scope of the session's owner. */
  asOwner: <T>(workspaceId: string, session: GuidedReviewSession, fn: () => T) => T
  notify: (workspaceId: string, change: GuidedReviewChange) => Promise<void>
}

/**
 * Editing comment drafts and posting them to the pull request. Posting claims each draft before
 * the host call, so two posts of the same drafts publish each comment once, and records the
 * host's answer per draft, so a partial post is reported rather than retried blind.
 */
export class GuidedReviewDrafts {
  constructor(private readonly deps: GuidedReviewDraftsDeps) {}

  async edit(
    workspaceId: string,
    userId: string,
    sessionId: string,
    draftId: string,
    input: EditGuidedReviewDraftInput,
  ): Promise<GuidedReviewCommentDraft> {
    const session = await this.deps.ownedSession(workspaceId, userId, sessionId)
    const draft = await this.deps.repository.getDraft(workspaceId, draftId)
    if (!draft || draft.sessionId !== sessionId) throw new NotFoundError('Comment draft', draftId)
    const { rev, discard, ...fields } = input
    if (discard && Object.values(fields).some((value) => value !== undefined)) {
      throw new ValidationError('A discard cannot also change the draft')
    }
    const anchor = {
      path: fields.path ?? draft.path,
      line: fields.line ?? draft.line,
      startLine: fields.startLine === undefined ? draft.startLine : fields.startLine,
      side: fields.side ?? draft.side,
    }
    const moved =
      anchor.path !== draft.path ||
      anchor.line !== draft.line ||
      anchor.startLine !== draft.startLine ||
      anchor.side !== draft.side
    if (moved) await this.assertAnchorable(workspaceId, session, anchor)
    const updated = await this.deps.repository.editDraft(
      workspaceId,
      draftId,
      rev,
      { ...fields, ...(discard ? { discard } : {}) },
      this.deps.clock.now(),
    )
    if (!updated) {
      throw new ConflictError('This draft changed since it was loaded', 'draft_conflict')
    }
    await this.deps.notify(workspaceId, { sessionId, scope: 'session' })
    return updated
  }

  async post(
    workspaceId: string,
    userId: string,
    sessionId: string,
    input: { draftIds: string[]; summary?: string },
  ): Promise<GuidedReviewPostResult> {
    const session = await this.deps.ownedSession(workspaceId, userId, sessionId)
    const repo = await this.deps.repoOf(workspaceId, session)
    const createReview = repo.createReview?.bind(repo)
    if (!createReview) throw new VcsCapabilityUnsupportedError(session.provider, 'createReview')
    await this.assertReviewedHead(workspaceId, session, repo)

    const now = this.deps.clock.now()
    const claimed = await this.deps.repository.claimDraftsForPost(
      workspaceId,
      sessionId,
      input.draftIds,
      now - GUIDED_REVIEW_POST_LEASE_MS,
      now,
    )
    const claimedIds = new Set(claimed.map((d) => d.id))
    const skipped = input.draftIds.filter((id) => !claimedIds.has(id))
    // The summary rides only with a draft this call claimed, so an identical retry after a
    // complete post publishes nothing at all rather than the summary a second time.
    const summary = claimed.length > 0 ? input.summary?.trim() : undefined

    let result: CreateReviewResult | null = null
    let failure: string | null = null
    if (claimed.length > 0) {
      try {
        result = await this.deps.asOwner(workspaceId, session, () =>
          createReview(session.prNumber, {
            event: 'COMMENT',
            ...(summary ? { body: compose(summary) } : {}),
            comments: claimed.map((d) => ({
              path: d.path,
              line: d.line,
              side: d.side,
              body: compose(d.body),
            })),
          }),
        )
      } catch (error) {
        failure = getErrorMessage(error)
      }
    }
    const outcomes: GuidedReviewDraftPostOutcome[] = claimed.map((d, i) => {
      const outcome = result?.comments[i]
      if (outcome?.posted) return { id: d.id, rev: d.rev, status: 'posted', postedUrl: null }
      return {
        id: d.id,
        rev: d.rev,
        status: 'failed',
        error: outcome?.error ?? failure ?? 'The host did not report this comment',
      }
    })
    await this.deps.repository.settleDraftPosts(workspaceId, outcomes, this.deps.clock.now())
    if (claimed.length > 0) await this.deps.notify(workspaceId, { sessionId, scope: 'session' })

    const drafts = await this.deps.repository.listDrafts(workspaceId, sessionId)
    return {
      drafts,
      posted: outcomes.filter((o) => o.status === 'posted').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      skipped,
      summary: {
        posted: summary ? (result?.bodyPosted ?? false) : null,
        error: summary ? (result?.bodyError ?? failure) : null,
      },
    }
  }

  private async assertAnchorable(
    workspaceId: string,
    session: GuidedReviewSession,
    anchor: { path: string; line: number; startLine: number | null; side: 'LEFT' | 'RIGHT' },
  ): Promise<void> {
    const repo = await this.deps.repoOf(workspaceId, session)
    const listChangedFiles = repo.listChangedFiles?.bind(repo)
    if (!listChangedFiles) {
      throw new VcsCapabilityUnsupportedError(session.provider, 'listChangedFiles')
    }
    const files: GitHubChangedFile[] = await this.deps.asOwner(workspaceId, session, () =>
      listChangedFiles(session.prNumber),
    )
    // The host lists the files of the PR's current head, which describe the reviewed diff only
    // while the head has not moved. Read after the listing, so a push between the two shows.
    await this.assertReviewedHead(workspaceId, session, repo)
    if (!isCommentableAnchor(files, anchor)) {
      throw new ValidationError(
        'A comment can only be placed on lines inside one hunk of the diff, starting before the line it ends on',
        { reason: 'draft_anchor_outside_diff' },
      )
    }
  }

  /** Every anchor was computed against the reviewed commit; a moved head can shift every line. */
  private async assertReviewedHead(
    workspaceId: string,
    session: GuidedReviewSession,
    repo: RepoFiles,
  ): Promise<void> {
    const getPullRequest = repo.getPullRequest?.bind(repo)
    if (!getPullRequest) throw new VcsCapabilityUnsupportedError(session.provider, 'getPullRequest')
    const pr = await this.deps.asOwner(workspaceId, session, () => getPullRequest(session.prNumber))
    if (!pr) throw new NotFoundError('Pull request', String(session.prNumber))
    const head = pr.headSha
    if (head !== session.reviewedHeadSha) {
      throw new ConflictError(
        'The pull request has new commits since this review was prepared',
        'session_stale',
        { reviewedHeadSha: session.reviewedHeadSha, currentHeadSha: head },
      )
    }
  }
}

/** A model- or human-authored comment, made safe for the host to render. */
function compose(text: string): string {
  return hostMarkdown.prose(redactSecrets(text) ?? '')
}
