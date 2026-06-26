import type {
  Block,
  GateContext,
  GateDefinition,
  GateHelperCompletionArgs,
  GateProbe,
  IncidentUpdate,
  PullRequestReviewSnapshot,
  ReleaseSignal,
} from '@cat-factory/kernel'
import {
  aggregateCi,
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  classifyReleaseHealth,
  CONFLICT_RESOLVER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  DEFAULT_MERGE_PRESET,
  describeFailingChecks,
  describeRegressedSignals,
  FIXER_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  isCiGreen,
  isProviderWired,
  listFailingChecks,
  ON_CALL_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  renderReleaseEvidence,
} from '@cat-factory/kernel'
import type { OnCallAssessment } from '@cat-factory/contracts'
import { parseOnCallAssessment } from '@cat-factory/contracts'
import {
  CI_STATUS_PROVIDER,
  INCIDENT_ENRICHMENT_PROVIDER,
  MERGEABILITY_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  RELEASE_HEALTH_PROVIDER,
} from './providers.js'
import {
  classifyHumanReview,
  isApproved,
  outstandingComments,
  outstandingThreads,
  requiredApprovals,
} from './review.logic.js'

/**
 * Conflict-resolver attempt cap. Unlike CI (where each fixer round gets fresh red-check
 * output to act on), a conflict retry re-merges the SAME base and gets no new signal, so a
 * large budget just burns containers re-attempting the same conflict (observed in prod: 10
 * attempts, head SHA never moved, run failed). Cap it low and fail fast to a
 * manual-resolution message instead of churning to CI's default of 10.
 */
const CONFLICT_RESOLVER_MAX_ATTEMPTS = 3

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/**
 * CI gate: poll the PR head's check runs; escalate to a `ci-fixer` on red CI. A
 * pass-through until {@link wireCiStatusProvider} supplies a provider.
 */
export const ciGate = (ctx: GateContext): GateDefinition => ({
  kind: CI_AGENT_KIND,
  helperKind: CI_FIXER_AGENT_KIND,
  wired: () => isProviderWired(CI_STATUS_PROVIDER),
  unwiredOutput: 'CI gate skipped (no CI status provider configured).',
  probe: async (workspaceId, blockId): Promise<GateProbe> => {
    const report = await ctx.requireProvider(CI_STATUS_PROVIDER).getStatus(workspaceId, blockId)
    const verdict = aggregateCi(report.checks)
    if (isCiGreen(verdict)) {
      return {
        status: 'pass',
        headSha: report.headSha,
        passOutput:
          verdict === 'none'
            ? 'CI gate passed: no checks configured for the PR head.'
            : `CI gate passed: ${report.checks.length} check(s) green.`,
      }
    }
    if (verdict === 'pending') return { status: 'pending', headSha: report.headSha }
    return {
      status: 'fail',
      headSha: report.headSha,
      failureSummary: describeFailingChecks(report.checks),
      failingChecks: listFailingChecks(report.checks),
    }
  },
  // Surface the failing-check summary to the fixer as resolved context.
  helperPriorOutput: (summary) => ({ agentKind: CI_AGENT_KIND, output: summary }),
  onExhausted: async ({ workspaceId, instance, block, step, summary }) => {
    const attempts = step.gate?.attempts ?? 0
    await ctx.raiseNotification(workspaceId, {
      type: 'ci_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `CI is still failing for "${block.title}"`,
      body:
        `The CI-fixer agent tried ${attempts} time(s) but CI is still red. ${summary ?? ''} ` +
        `Take a look and retry the run once fixed.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
    return {
      error: `CI did not pass after ${attempts} CI-fixer attempt(s). ${summary ?? ''}`.trim(),
    }
  },
})

/**
 * Conflicts gate: check PR mergeability; escalate to a `conflict-resolver` on conflict. A
 * pass-through until {@link wireMergeabilityProvider} supplies a provider.
 */
export const conflictsGate = (ctx: GateContext): GateDefinition => ({
  kind: CONFLICTS_AGENT_KIND,
  helperKind: CONFLICT_RESOLVER_AGENT_KIND,
  wired: () => isProviderWired(MERGEABILITY_PROVIDER),
  unwiredOutput: 'Conflict gate skipped (no mergeability provider configured).',
  attemptBudget: () => CONFLICT_RESOLVER_MAX_ATTEMPTS,
  probe: async (workspaceId, blockId): Promise<GateProbe> => {
    const report = await ctx
      .requireProvider(MERGEABILITY_PROVIDER)
      .getMergeability(workspaceId, blockId)
    // No PR resolved, or it merges cleanly → nothing to do; advance.
    if (report.headSha === null || report.verdict === 'mergeable') {
      return {
        status: 'pass',
        headSha: report.headSha,
        passOutput:
          report.headSha === null
            ? 'Conflict gate passed: no open PR to gate.'
            : 'Conflict gate passed: the PR merges cleanly with its base.',
      }
    }
    // GitHub still computing mergeability → keep polling.
    if (report.verdict === 'unknown') return { status: 'pending', headSha: report.headSha }
    return { status: 'fail', headSha: report.headSha }
  },
  onExhausted: async ({ step }) => ({
    error:
      `The pull request still conflicts with its base after ` +
      `${step.gate?.attempts ?? 0} conflict-resolver attempt(s). Resolve the conflict ` +
      `manually, then retry the run.`,
  }),
})

/** Raise a `release_regression` notification carrying the on-call assessment + signals. */
async function raiseReleaseRegression(
  ctx: GateContext,
  workspaceId: string,
  args: Pick<GateHelperCompletionArgs, 'instance' | 'block'>,
  assessment: OnCallAssessment | null,
  signals: ReleaseSignal[],
  summary: string,
): Promise<void> {
  const { instance, block } = args
  const body = assessment
    ? `Post-release monitoring flagged a regression after this PR shipped. On-call recommends ` +
      `**${assessment.recommendation}** (culprit confidence ${pct(assessment.culpritConfidence)}). ` +
      `${assessment.rationale}`
    : `Post-release monitoring flagged a regression after this PR shipped. ${summary} ` +
      `Investigate before deciding whether to revert.`
  await ctx.raiseNotification(workspaceId, {
    type: 'release_regression',
    blockId: block.id,
    executionId: instance.id,
    title: `Release regression for "${block.title}"`,
    body,
    payload: {
      ...(assessment ? { onCallAssessment: assessment } : {}),
      ...(signals.length ? { releaseSignals: signals } : {}),
      ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
      pipelineName: instance.pipelineName,
    },
  })
}

/**
 * Best-effort: annotate an incident PagerDuty / incident.io already opened (from the same
 * monitors/SLOs) with the on-call investigation. NOT alerting — those systems already
 * paged. A no-op when no provider is wired or no matching incident exists.
 */
async function enrichIncident(
  ctx: GateContext,
  workspaceId: string,
  args: Pick<GateHelperCompletionArgs, 'block'>,
  assessment: OnCallAssessment | null,
  signals: ReleaseSignal[],
  since: number,
): Promise<void> {
  const incidentEnrichment = ctx.getProvider(INCIDENT_ENRICHMENT_PROVIDER)
  if (!incidentEnrichment) return
  const { block } = args
  const update: IncidentUpdate = {
    title: `Regression suspected from "${block.title}"`,
    body: assessment
      ? `${assessment.rationale} (recommendation: ${assessment.recommendation}, culprit confidence ${pct(assessment.culpritConfidence)})`
      : 'cat-factory on-call investigated a post-release regression suspected from this change.',
    ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
  }
  try {
    await incidentEnrichment.enrich(
      { workspaceId, signalIds: signals.map((s) => s.id), since },
      update,
    )
  } catch {
    // best-effort: a failing enrichment must not block the run or the notification
  }
}

/**
 * Post-release-health gate: after deploy, watch the release's Datadog monitors/SLOs over a
 * window; escalate to the `on-call` agent on a regression. The on-call agent INVESTIGATES
 * (it makes no commits and doesn't change prod), so its completion is resolved specially via
 * {@link GateDefinition.resolveHelperCompletion} — it must NOT re-probe (that would just
 * regress again and burn the budget). A pass-through until {@link wireReleaseHealthProvider}.
 */
export const postReleaseHealthGate = (ctx: GateContext): GateDefinition => ({
  kind: POST_RELEASE_HEALTH_AGENT_KIND,
  helperKind: ON_CALL_AGENT_KIND,
  wired: () => isProviderWired(RELEASE_HEALTH_PROVIDER),
  unwiredOutput: 'Post-release health gate skipped (no release-health provider configured).',
  attemptBudget: (preset) => preset.releaseMaxAttempts,
  // Running out of poll budget while still watching means the window outlasted the driver's
  // budget with NO regression observed — a healthy pass, not a timeout.
  pollExhaustion: 'pass',
  probe: async (workspaceId, blockId, gateState): Promise<GateProbe> => {
    // Only watch a release that actually SHIPPED. The merger sets the block `done` when it
    // merges for real, but leaves it `pr_ready` when it raises a review without merging — and
    // a no-merger pipeline also never auto-merges. There is nothing deployed to watch in
    // those cases, so pass through immediately instead of polling Datadog (and possibly
    // escalating an on-call investigation) for a change that was never released.
    const block = await ctx.getBlock(workspaceId, blockId)
    if (!block || block.status !== 'done') {
      return {
        status: 'pass',
        headSha: null,
        passOutput:
          'Post-release health gate skipped: the PR was not merged (nothing deployed to watch).',
      }
    }
    const since = gateState.watchSince ?? ctx.clock.now()
    const report = await ctx
      .requireProvider(RELEASE_HEALTH_PROVIDER)
      .probe(workspaceId, blockId, since)
    // No signals configured for this block → nothing to watch; advance immediately (don't
    // park for the whole window on an unmapped release).
    if (report.signals.length === 0) {
      return {
        status: 'pass',
        headSha: null,
        passOutput:
          'Post-release health gate passed: no monitors/SLOs configured for this release.',
      }
    }
    // The watch window is resolved ONCE on first entry and stashed on the gate state (see
    // evaluateGate), so the probe doesn't re-load the block + re-resolve the merge preset on
    // every poll over the window.
    const windowMinutes =
      gateState.watchWindowMinutes ?? DEFAULT_MERGE_PRESET.releaseWatchWindowMinutes
    const windowElapsed = ctx.clock.now() - since >= windowMinutes * 60_000
    const verdict = classifyReleaseHealth({ report, windowElapsed })
    if (verdict === 'pass') {
      return {
        status: 'pass',
        headSha: null,
        passOutput: `Post-release health gate passed: ${report.signals.length} signal(s) healthy through the watch window.`,
      }
    }
    if (verdict === 'pending') return { status: 'pending', headSha: null }
    return {
      status: 'fail',
      headSha: null,
      failureSummary: describeRegressedSignals(report.signals),
    }
  },
  // The on-call agent gets the full evidence bundle (regressed signals + recent error logs),
  // gathered fresh at dispatch.
  gatherHelperPriorOutputs: async (workspaceId, blockId, gateState) => {
    const since = gateState.watchSince ?? ctx.clock.now()
    const evidence = await ctx
      .requireProvider(RELEASE_HEALTH_PROVIDER)
      .gatherEvidence(workspaceId, blockId, since)
    // Stash the regressed signals on the gate state so the on-call COMPLETION handler
    // (resolveHelperCompletion) builds the notification + incident enrichment from the SAME
    // evidence the agent investigated — rather than re-reading Datadog a third time. The
    // caller spreads `...step.gate` right after, so this mutation persists.
    gateState.regressedSignals = evidence.regressedSignals
    return [{ agentKind: POST_RELEASE_HEALTH_AGENT_KIND, output: renderReleaseEvidence(evidence) }]
  },
  onExhausted: async ({ workspaceId, instance, block, step, summary }) => {
    // Reached when releaseMaxAttempts is 0 (operator disabled the on-call investigation) or
    // there is no async executor to escalate to — a FAILED investigation is handled by
    // resolveHelperCompletion, not here. Alert a human via the notification (with any signals
    // already captured), then flag the run.
    await raiseReleaseRegression(
      ctx,
      workspaceId,
      { instance, block },
      null,
      step.gate?.regressedSignals ?? [],
      summary ?? '',
    )
    return {
      error:
        `Post-release health regressed and no on-call investigation was configured. ${summary ?? ''}`.trim(),
    }
  },
  // The on-call helper INVESTIGATES — it changes nothing the precheck would re-observe — so on
  // its completion (or failure) we resolve specially instead of re-probing: raise the
  // `release_regression` notification (from the signals stashed at escalation), enrich any open
  // incident, and finish the gate step so the run completes for a human to act out-of-band.
  resolveHelperCompletion: async ({ workspaceId, instance, block, step, result }) => {
    const investigationFailed = result.state === 'failed'
    let assessment: OnCallAssessment | null = null
    if (result.state === 'done') {
      try {
        assessment = parseOnCallAssessment(result.result.onCallAssessment)
      } catch {
        assessment = null
      }
    }
    // Reuse the regressed signals captured when the gate escalated (see
    // gatherHelperPriorOutputs) so the notification + incident enrichment reflect exactly what
    // the on-call agent investigated. Only fall back to a fresh gather if they weren't
    // persisted (e.g. an older parked run).
    const since = step.gate?.watchSince ?? ctx.clock.now()
    let regressedSignals: ReleaseSignal[] = step.gate?.regressedSignals ?? []
    const provider = ctx.getProvider(RELEASE_HEALTH_PROVIDER)
    if (regressedSignals.length === 0 && provider) {
      try {
        const evidence = await provider.gatherEvidence(workspaceId, block.id, since)
        regressedSignals = evidence.regressedSignals
      } catch {
        // best-effort: the assessment + summary still drive the notification
      }
    }
    const baseSummary = step.gate?.lastFailureSummary ?? ''
    const summary = investigationFailed
      ? `${baseSummary} The automated on-call investigation could not complete, so no culprit assessment is available — investigate manually.`.trim()
      : baseSummary
    await raiseReleaseRegression(
      ctx,
      workspaceId,
      { instance, block },
      assessment,
      regressedSignals,
      summary,
    )
    await enrichIncident(ctx, workspaceId, { block }, assessment, regressedSignals, since)
    const output = assessment
      ? `On-call investigation: ${assessment.recommendation} (culprit confidence ${pct(assessment.culpritConfidence)}). ${assessment.rationale}`
      : investigationFailed
        ? 'On-call investigation did not complete; raised a release-regression notification for manual triage.'
        : 'On-call investigation completed; see the release-regression notification.'
    return { output }
  },
})

/** The reply the fixer's round leaves on each review thread before it is resolved. */
const REVIEW_THREAD_RESOLVED_REPLY =
  'Addressed by the cat-factory fixer in the latest commit(s) on this branch.'

/**
 * Human-review gate: watch the PR for a human code review on GitHub. It advances once the PR
 * meets GitHub's required approvals with no unresolved review threads; on outstanding feedback it
 * loops the `fixer` (immediately when approved; after a grace window otherwise), resolving each
 * handed thread on the helper's completion so the next probe sees it cleared. It waits
 * indefinitely for the human — `pollExhaustion: 'rearm'` never times out and an effectively
 * unbounded attempt budget means a long review is never auto-failed. A pass-through until
 * {@link wirePullRequestReviewProvider} supplies a provider.
 */
export const humanReviewGate = (ctx: GateContext): GateDefinition => ({
  kind: HUMAN_REVIEW_AGENT_KIND,
  helperKind: FIXER_AGENT_KIND,
  wired: () => isProviderWired(PULL_REQUEST_REVIEW_PROVIDER),
  unwiredOutput: 'Human review gate skipped (no PR-review provider configured).',
  // A human review is unbounded: never time out the wait, and never give up on rounds.
  pollExhaustion: 'rearm',
  attemptBudget: () => Number.MAX_SAFE_INTEGER,
  probe: async (workspaceId, blockId, gateState): Promise<GateProbe> => {
    const provider = ctx.requireProvider(PULL_REQUEST_REVIEW_PROVIDER)
    // Raise (or re-raise — `NotificationService.raise` dedups per block+type) the human_review
    // card, carrying the run's `executionId` from the block so the inbox can deep-link straight
    // into the gate window (where the human requests a freeform fix); the probe has no instance
    // in scope, but `block.executionId` is the run currently parked on this gate.
    const raiseHumanReviewCard = async (
      build: (block: Block | null) => { title: string; body: string },
    ): Promise<void> => {
      const block = await ctx.getBlock(workspaceId, blockId)
      const { title, body } = build(block)
      await ctx.raiseNotification(workspaceId, {
        type: 'human_review',
        blockId,
        executionId: block?.executionId ?? null,
        title,
        body,
        payload: block?.pullRequest?.url ? { prUrl: block.pullRequest.url } : {},
      })
    }
    // A transient GitHub read failure must NEVER fail the run — this gate waits indefinitely
    // for a human, so a momentary 502 / rate-limit / GraphQL error is just "keep waiting", not
    // a verdict. (The driver's FIRST gate entry runs outside the fault-tolerant poll loop, so
    // without this catch a single blip would terminally fail an otherwise-healthy review wait.)
    let snapshot: PullRequestReviewSnapshot
    try {
      snapshot = await provider.getReview(
        workspaceId,
        blockId,
        gateState.requiredApprovingReviewCount ?? null,
      )
    } catch {
      return { status: 'pending', headSha: gateState.headSha ?? null }
    }
    // Reconcile threads a prior fixer round addressed but whose GitHub-side resolve didn't land
    // (a transient failure in onHelperComplete). Those ids were RETAINED on the gate state
    // (onHelperComplete clears them only on a successful resolve), so re-attempt the resolve for
    // exactly those still open (resolve-only, empty reply → no duplicate comment), and keep any
    // still open for the next retry. Scoping strictly to ids the gate itself handed the fixer —
    // never "any bot-latest thread" — guarantees a THIRD-PARTY reviewer bot's (e.g. a code-review
    // bot's) open thread is never silently closed. Best-effort: a failure here just retries.
    const handed = gateState.pendingThreadIds ?? []
    if (handed.length > 0) {
      const stillOpen = handed.filter((id) =>
        snapshot.unresolvedThreads.some((t) => t.threadId === id),
      )
      if (stillOpen.length > 0) {
        try {
          await provider.resolveThreads(workspaceId, blockId, stillOpen, '')
        } catch {
          // best-effort: retained below; the next poll re-attempts
        }
      }
      gateState.pendingThreadIds = stillOpen.length > 0 ? stillOpen : null
    }
    const graceMinutes =
      gateState.humanReviewGraceMinutes ?? DEFAULT_MERGE_PRESET.humanReviewGraceMinutes
    // Surface the approval progress for the UI (persisted via the caller's `...step.gate` spread),
    // and cache the static branch-protection required count so later polls skip re-reading it.
    gateState.lastApprovals = snapshot.approvals
    gateState.requiredApprovals = snapshot.headSha === null ? null : requiredApprovals(snapshot)
    if (snapshot.headSha !== null) {
      gateState.requiredApprovingReviewCount = snapshot.requiredApprovingReviewCount
    }
    const verdict = classifyHumanReview(snapshot, gateState, { graceMinutes, now: ctx.clock.now() })
    if (verdict.kind === 'advance') {
      return { status: 'pass', headSha: snapshot.headSha, passOutput: verdict.reason }
    }
    if (verdict.kind === 'dispatch') {
      // Backoff: the fixer addresses feedback by pushing a commit to the PR branch, so a fixer
      // round that left the head sha unchanged made no progress (it failed, or pushed nothing).
      // Re-dispatching a fresh fixer on every poll for the same unchanged head would hot-loop a
      // container indefinitely (the budget is effectively unbounded). Wait instead until the head
      // advances (a new fixer commit) or the human re-engages. The prior attempt's gated head is
      // the last entry of the attempt log.
      const lastAttempt = gateState.attemptLog?.[gateState.attemptLog.length - 1]
      if (lastAttempt && lastAttempt.headSha === snapshot.headSha) {
        // The automated loop has stalled (the fixer made no progress on the same head) while
        // feedback is still outstanding — surface a card so the human knows to intervene rather
        // than letting the run wait silently and invisibly forever.
        await raiseHumanReviewCard((block) => ({
          title: `Review feedback needs attention on "${block?.title ?? 'this task'}"`,
          body:
            'The automated fixer could not make further progress on the review feedback ' +
            '(no new commit since its last attempt). Review the PR on GitHub, or request a fix here.',
        }))
        return { status: 'pending', headSha: snapshot.headSha }
      }
      // Stash the threads to resolve on the fixer's completion + advance the plain-comment
      // cursor so the same comments don't re-trigger. Both persist via the caller's spread.
      gateState.pendingThreadIds = verdict.threadIds
      if (verdict.latestCommentAt != null) {
        gateState.lastAddressedCommentAt = Math.max(
          gateState.lastAddressedCommentAt ?? 0,
          verdict.latestCommentAt,
        )
      }
      return { status: 'fail', headSha: snapshot.headSha, failureSummary: verdict.instructions }
    }
    // wait: keep polling. When we're waiting on a human APPROVAL (nothing outstanding to fix),
    // surface a (deduped) notification so the reviewer is summoned and the severity sweep can
    // escalate it the longer it waits. A grace-window wait (comments present) needs no card.
    const awaitingApproval =
      outstandingThreads(snapshot).length === 0 &&
      outstandingComments(snapshot, gateState.lastAddressedCommentAt).length === 0 &&
      !isApproved(snapshot)
    if (awaitingApproval) {
      await raiseHumanReviewCard((block) => {
        const title = block?.title ?? 'this task'
        // "No reviewer" only when nobody is assigned AND nobody has approved yet — a reviewer who
        // approves is removed from the requested-reviewer list, so `assignedReviewers` alone would
        // wrongly tell the user to assign a reviewer who already signed off (e.g. 1 of 2 approvals
        // in). With an approval on record the real state is "needs more approvals", not "unassigned".
        const noReviewer = snapshot.assignedReviewers.length === 0 && snapshot.approvals === 0
        return {
          title: noReviewer
            ? `Assign a reviewer for "${title}"`
            : `"${title}" is awaiting code review`,
          body: noReviewer
            ? 'The PR has no assigned reviewer. Request a reviewer on GitHub to continue, or request a fix here.'
            : `Awaiting ${requiredApprovals(snapshot)} approval(s) on the PR ` +
              `(have ${snapshot.approvals}). Review on GitHub, or request a fix here.`,
        }
      })
    }
    return { status: 'pending', headSha: snapshot.headSha }
  },
  // Fold the reviewer's feedback into the fixer's prompt.
  helperPriorOutput: (summary) => ({ agentKind: HUMAN_REVIEW_AGENT_KIND, output: summary }),
  // After a SUCCESSFUL fixer round, reply to + RESOLVE the threads it was handed, so the
  // immediately following re-probe counts them as addressed. A FAILED fixer addressed nothing,
  // so its threads are left open (resolving them would post a misleading "addressed" reply and
  // hide unfixed feedback from the gate) — the negative state makes the next probe re-dispatch.
  // Best-effort: on a SUCCESS whose GitHub-side resolve threw transiently, the handed ids are
  // RETAINED (not cleared) so the probe's reconcile re-attempts exactly those — that retention is
  // what keeps the reconcile precise (it touches only gate-handed threads, never any bot thread).
  onHelperComplete: async ({ workspaceId, block, step, result }) => {
    const threadIds = step.gate?.pendingThreadIds ?? []
    // A failed fixer (or nothing handed): drop the stash without resolving anything.
    if (result.state !== 'done' || threadIds.length === 0) {
      if (step.gate) step.gate.pendingThreadIds = null
      return
    }
    const provider = ctx.getProvider(PULL_REQUEST_REVIEW_PROVIDER)
    if (!provider) {
      if (step.gate) step.gate.pendingThreadIds = null
      return
    }
    try {
      await provider.resolveThreads(workspaceId, block.id, threadIds, REVIEW_THREAD_RESOLVED_REPLY)
      if (step.gate) step.gate.pendingThreadIds = null
    } catch {
      // Resolve threw — RETAIN the handed ids so the next probe's reconcile retries the resolve
      // (scoped to exactly these gate-handed threads); leaving them set is deliberate.
    }
  },
  // Never reached (the attempt budget is effectively unbounded), but raise a card defensively so
  // a misconfiguration surfaces rather than silently failing the run.
  onExhausted: async ({ workspaceId, instance, block }) => {
    await ctx.raiseNotification(workspaceId, {
      type: 'human_review',
      blockId: block.id,
      executionId: instance.id,
      title: `Human review needed for "${block.title}"`,
      body: 'The human-review gate could not continue automatically. Review the PR on GitHub.',
      payload: block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {},
    })
    return { error: 'Human review did not complete.' }
  },
})
