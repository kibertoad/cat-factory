import type {
  AgentRunContext,
  AgentRunResult,
  Block,
  CreateReviewResult,
  ExecutionInstance,
  PipelineStep,
  ResolveRunRepoContext,
  RunInitiatorScope,
} from '@cat-factory/kernel'
import { FIXER_AGENT_KIND, getErrorMessage } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import {
  buildPrReviewPost,
  buildPrReviewPostReport,
  computeCommentableLines,
  isPrReviewPostComplete,
  renderPrReviewFixerFeedback,
} from './prReview.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepHandlerContext } from './step-handler-registry.js'

/**
 * Resolve a review `Block`'s PR number: an explicit `taskTypeFields.prNumber`, else parsed from
 * the `prUrl` (`…/pull/42` on GitHub, `…/merge_requests/42` on GitLab). Undefined when neither
 * yields one — the PR-review `fix`/`post` resolutions then report the PR unresolvable.
 */
function reviewPrNumber(block: Block | null | undefined): number | undefined {
  const fields = block?.taskTypeFields
  if (typeof fields?.prNumber === 'number') return fields.prNumber
  const url = fields?.prUrl?.trim()
  const match = url?.match(/\/(?:pull|merge_requests)\/(\d+)/)
  return match ? Number(match[1]) : undefined
}

/** The dispatcher hooks the PR-review resolution driver needs (mirrors {@link DeployerStepController}'s seam). */
export interface PrReviewResolutionControllerDeps {
  runStateMachine: RunStateMachine
  resolveRunRepoContext?: ResolveRunRepoContext
  runInitiatorScope: RunInitiatorScope
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  handleAgentStep: (
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ) => Promise<AdvanceResult>
}

/**
 * The DRIVER-side half of the PR deep-review resolution (the human-facing half is
 * {@link PrReviewController}). After the human resolved a parked review with `fix` or `post`,
 * `PrReviewController.resolve` re-armed the `pr-reviewer` step and woke the durable driver;
 * {@link handle} runs on re-entry. Extracted from {@link RunDispatcher} as a cohesive collaborator
 * (all PR-review-resolution driver logic in one place), constructed like the other step
 * controllers with bound call-backs into the dispatcher's completion / agent-dispatch methods.
 */
export class PrReviewResolutionController {
  constructor(private readonly deps: PrReviewResolutionControllerDeps) {}

  /**
   * - `fixing`: dispatch the Fixer against the reviewed PR's head branch with the selected
   *   findings folded in (parks on the job; its completion marks the review `done`).
   * - `posting`: publish the selected findings as inline PR review comments, then finish the step.
   */
  handle(ctx: StepHandlerContext): Promise<AdvanceResult> {
    if (ctx.step.prReview?.status === 'posting') return this.post(ctx)
    return this.dispatchFixer(ctx)
  }

  /**
   * Dispatch the Fixer for a PR-review `fix` resolution. A `review` task carries no own work
   * branch — it reviews an EXISTING PR — so resolve the PR's head branch (via the checkout-free
   * `RepoFiles`) and point the Fixer's clone/push at it: fold a synthetic `pullRequest` + an
   * apriori WORKING branch into the dispatch context so the shared `container-coding` +
   * `clone:{branch:'pr'}` fixer body clones + pushes that branch (no new PR), and hand it the
   * selected findings as a prior output (the same injection point the gate helpers use). Fails
   * the run loudly when the PR branch can't be resolved (nothing to push to) rather than pushing
   * blind. On a replay (jobId already set) it re-attaches without re-resolving.
   */
  private async dispatchFixer(ctx: StepHandlerContext): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block } = ctx
    const review = step.prReview!
    const selected = (review.findings ?? []).filter((f) =>
      review.selectedFindingIds?.includes(f.id),
    )
    let headRef: string | null = null
    let prNumber: number | undefined
    if (!step.jobId) {
      prNumber = reviewPrNumber(block)
      const runRepo =
        prNumber != null ? await this.deps.resolveRunRepoContext?.(workspaceId, block.id) : null
      const repo = runRepo?.repo
      headRef =
        prNumber != null && repo?.pullRequestHeadRef
          ? await this.deps.runInitiatorScope(instance.initiatedBy, () =>
              repo.pullRequestHeadRef!(prNumber!),
            )
          : null
      if (prNumber == null || !headRef) {
        return {
          kind: 'job_failed',
          failureKind: 'preflight',
          error:
            "Can't resolve the reviewed pull request's head branch to push fixes to. The " +
            "'fix' resolution needs a same-repo pull request on this service's linked repository " +
            '(a cross-repo or fork PR is not yet supported — post the findings as comments instead).',
        }
      }
    }
    const resolvedHeadRef = headRef
    const resolvedPrNumber = prNumber
    return this.deps.handleAgentStep(ctx, FIXER_AGENT_KIND, (context) => {
      if (resolvedHeadRef && resolvedPrNumber != null) {
        context.block.pullRequest = {
          number: resolvedPrNumber,
          branch: resolvedHeadRef,
          url: review.prUrl ?? '',
        }
        // Build inside the PR head branch (probed, never created) so the work-branch machinery
        // targets it rather than minting a stray `cat-factory/<blockId>` off base.
        context.aprioriBranches = [{ name: resolvedHeadRef, mode: 'working' }]
      }
      context.priorOutputs = [
        ...context.priorOutputs,
        { agentKind: FIXER_AGENT_KIND, output: renderPrReviewFixerFeedback(selected) },
      ]
    })
  }

  /**
   * Post a PR-review `post` resolution: publish the human-selected findings on the reviewed PR
   * via the checkout-free `RepoFiles.createReview`, which posts each inline comment INDIVIDUALLY
   * (not one atomic review) so one un-anchorable line can't reject the rest. At-most-once: the
   * `pendingPrReviewPost` marker is consumed (cleared + persisted) BEFORE the side-effecting post
   * so a Workflows retry can't re-run it; findings that already posted on a prior attempt
   * (`postedFindingIds`) are skipped; and the summary/body comment is suppressed once it has
   * landed (`postedBody`), so a human RE-`post` (the retry path) never double-posts an inline
   * comment OR the summary that already landed.
   *
   * Observability + resilience (the point of this handler):
   * - The 422 ROOT CAUSE — a finding anchored to a line outside the PR diff — is pre-empted by
   *   {@link computeCommentableLines}: such a finding is folded into the summary comment instead
   *   of being sent as an inline comment that GitHub would reject.
   * - The per-comment outcome is reduced to a {@link buildPrReviewPostReport} recorded on
   *   `step.prReview.postReport` (how many of how many posted, which failed + why, how many were
   *   folded), which the deep-review window renders.
   * - On a FULLY successful post the step finishes `done`. On ANY partial/failed post the run is
   *   RE-PARKED at `awaiting_selection` carrying the report — never failed opaquely — so the human
   *   sees what happened and can retry ONLY the posting (re-`post`, which skips what already
   *   landed) or switch to `fix`/`finish`. This replaces the old "fail the whole run loudly and
   *   get stuck on a spinner" behaviour.
   *
   * When no VCS review write is wired (tests / no GitHub) the findings are recorded and the step
   * finishes — the review pipeline never reaches this without GitHub in practice.
   */
  private async post(ctx: StepHandlerContext): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block, isFinalStep } = ctx
    const review = step.prReview!
    const alreadyPosted = new Set(review.postedFindingIds ?? [])
    // The findings to post THIS attempt: selected, minus any that already landed on a prior try.
    const selected = (review.findings ?? []).filter(
      (f) => review.selectedFindingIds?.includes(f.id) && !alreadyPosted.has(f.id),
    )

    // A replay after the marker was consumed (no marker) just completes idempotently — the post
    // already ran on the winning attempt; do not re-post.
    if (!step.pendingPrReviewPost) {
      step.prReview = { ...review, status: 'done' }
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: `Posted ${alreadyPosted.size} review comment${alreadyPosted.size === 1 ? '' : 's'} to the pull request.`,
      })
    }
    step.pendingPrReviewPost = null
    await this.deps.runStateMachine.casPersist(workspaceId, instance)

    const prNumber = reviewPrNumber(block)
    const runRepo =
      prNumber != null ? await this.deps.resolveRunRepoContext?.(workspaceId, block.id) : null
    const repo = runRepo?.repo
    if (prNumber == null || !repo?.createReview) {
      // No VCS write wired: record the selection and finish (no real post; tests / no GitHub).
      step.prReview = { ...review, status: 'done', postReport: null }
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: `Recorded ${selected.length} selected finding${selected.length === 1 ? '' : 's'}.`,
      })
    }

    // Detect branch DRIFT: if the PR head moved since the review started, the findings' frozen
    // line numbers may now point at shifted/different code, so posting inline comments would
    // anchor them to the wrong lines. Re-read the current head and compare to the sha captured at
    // review start. Best-effort: an unknown sha on either side (no capability / older run / read
    // blip) leaves `staleHead` false, so the pre-existing per-line diff filtering still applies.
    let staleHead = false
    if (review.reviewedHeadSha && repo.pullRequestHeadSha) {
      try {
        const headSha = repo.pullRequestHeadSha
        const currentHeadSha = await this.deps.runInitiatorScope(instance.initiatedBy, () =>
          headSha(prNumber),
        )
        staleHead = currentHeadSha != null && currentHeadSha !== review.reviewedHeadSha
      } catch {
        staleHead = false
      }
    }

    // Pre-filter against the actual PR diff so out-of-diff lines are folded into the summary
    // rather than sent as inline comments GitHub would 422. Best-effort: if the changed-file
    // read fails or isn't wired, we skip the filter and let per-comment posting report failures.
    // Skipped when the head drifted — `staleHead` already folds every finding, so the diff read
    // would be wasted work against a diff the findings no longer map onto cleanly.
    let commentable: ReturnType<typeof computeCommentableLines> | undefined
    if (!staleHead) {
      try {
        const files = await repo.listChangedFiles?.(prNumber)
        if (files) commentable = computeCommentableLines(files)
      } catch {
        commentable = undefined
      }
    }

    const built = buildPrReviewPost(selected, review.summary, commentable, { staleHead })
    // The summary/body comment is posted AT MOST ONCE. If it already landed on a prior attempt,
    // suppress it here so retrying the un-anchored inline comments doesn't duplicate the summary
    // conversation comment (the body's analogue of `postedFindingIds`). A body that FAILED before
    // keeps `postedBody` false, so it is still retried.
    const bodyAlreadyPosted = review.postedBody === true
    const input = bodyAlreadyPosted ? { ...built.input, body: '' } : built.input
    let result: CreateReviewResult
    try {
      result = await this.deps.runInitiatorScope(instance.initiatedBy, () =>
        repo.createReview!(prNumber, input),
      )
    } catch (error) {
      // createReview reports per-comment failures rather than throwing; an actual throw means it
      // couldn't even begin. Treat every comment as failed so the outcome is still reported (and
      // retryable) instead of failing the whole run.
      const reason = getErrorMessage(error)
      result = {
        comments: input.comments.map(() => ({ posted: false, error: reason })),
        bodyPosted: input.body ? false : null,
        bodyError: input.body ? reason : undefined,
      }
    }

    const { report, newlyPostedFindingIds } = buildPrReviewPostReport(built, selected, result)
    const postedFindingIds = [...alreadyPosted, ...newlyPostedFindingIds]
    // Sticky: once the summary lands it stays posted, so a further retry keeps suppressing it.
    const postedBody = bodyAlreadyPosted || result.bodyPosted === true
    step.prReview = { ...review, postReport: report, postedFindingIds, postedBody }

    if (isPrReviewPostComplete(report)) {
      step.prReview = { ...step.prReview, status: 'done' }
      const total = postedFindingIds.length
      const foldedReason = staleHead
        ? 'the branch was updated after the review started'
        : 'no in-diff line to anchor to'
      const foldedNote =
        report.folded > 0
          ? ` (${report.folded} finding${report.folded === 1 ? '' : 's'} added to the summary — ${foldedReason})`
          : ''
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: `Posted ${total} review comment${total === 1 ? '' : 's'} to the pull request${foldedNote}.`,
      })
    }

    // Partial or failed: re-park at `awaiting_selection` carrying the report so the window shows
    // what posted / what failed and the human can retry only the posting (re-`post`).
    step.prReview = { ...step.prReview, status: 'awaiting_selection', resolution: null }
    return this.deps.runStateMachine.parkStepOnDecision(workspaceId, instance, step)
  }
}
