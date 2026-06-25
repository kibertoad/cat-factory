import type {
  GateContext,
  GateDefinition,
  GateHelperCompletionArgs,
  GateProbe,
  IncidentUpdate,
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
  isCiGreen,
  listFailingChecks,
  ON_CALL_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  renderReleaseEvidence,
} from '@cat-factory/kernel'
import type { OnCallAssessment } from '@cat-factory/contracts'
import { parseOnCallAssessment } from '@cat-factory/contracts'
import {
  getCiStatusProvider,
  getIncidentEnrichment,
  getMergeabilityProvider,
  getReleaseHealthProvider,
} from './providers.js'

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
  wired: () => !!getCiStatusProvider(),
  unwiredOutput: 'CI gate skipped (no CI status provider configured).',
  probe: async (workspaceId, blockId): Promise<GateProbe> => {
    const report = await getCiStatusProvider()!.getStatus(workspaceId, blockId)
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
export const conflictsGate = (_ctx: GateContext): GateDefinition => ({
  kind: CONFLICTS_AGENT_KIND,
  helperKind: CONFLICT_RESOLVER_AGENT_KIND,
  wired: () => !!getMergeabilityProvider(),
  unwiredOutput: 'Conflict gate skipped (no mergeability provider configured).',
  attemptBudget: () => CONFLICT_RESOLVER_MAX_ATTEMPTS,
  probe: async (workspaceId, blockId): Promise<GateProbe> => {
    const report = await getMergeabilityProvider()!.getMergeability(workspaceId, blockId)
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
  workspaceId: string,
  args: Pick<GateHelperCompletionArgs, 'block'>,
  assessment: OnCallAssessment | null,
  signals: ReleaseSignal[],
  since: number,
): Promise<void> {
  const incidentEnrichment = getIncidentEnrichment()
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
  wired: () => !!getReleaseHealthProvider(),
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
    const report = await getReleaseHealthProvider()!.probe(workspaceId, blockId, since)
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
    const evidence = await getReleaseHealthProvider()!.gatherEvidence(workspaceId, blockId, since)
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
    const provider = getReleaseHealthProvider()
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
    await enrichIncident(workspaceId, { block }, assessment, regressedSignals, since)
    const output = assessment
      ? `On-call investigation: ${assessment.recommendation} (culprit confidence ${pct(assessment.culpritConfidence)}). ${assessment.rationale}`
      : investigationFailed
        ? 'On-call investigation did not complete; raised a release-regression notification for manual triage.'
        : 'On-call investigation completed; see the release-regression notification.'
    return { output }
  },
})
