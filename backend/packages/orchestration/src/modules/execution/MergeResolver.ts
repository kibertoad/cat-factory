import type {
  Block,
  BlockRepository,
  ChangeClass,
  ClassRulesByRole,
  ExecutionInstance,
  MergeAssessment,
  MergeAxis,
  MergeClassRule,
  MergeClassRules,
  MergeDecision,
  SubmissionClassesByRole,
} from '@cat-factory/kernel'
import {
  isDryRun,
  parseMergeAssessment,
  resolveRoleScopedMergeClassRule,
  submissionAllowedForRole,
  submissionAllowlistForRole,
} from '@cat-factory/contracts'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { MergeTrackRecordService } from '../merge/MergeTrackRecordService.js'

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** The auto-merge ceilings the resolver compares a merger assessment against. */
interface MergeThresholds {
  /** The resolved preset's id, absent when the built-in constant fallback was used. */
  id?: string
  /** The resolved preset's display name (block pin → workspace default → built-in). */
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  /** When false, auto-merge is disabled outright — every PR is routed to human review. */
  autoMergeEnabled: boolean
  /**
   * Per-change-class rules. An absent class (or an absent map) means "use the ceilings above",
   * so a preset with no rules behaves exactly as it did before this existed.
   */
  classRules?: MergeClassRules
  /**
   * Per-role narrowing of {@link classRules}, applied against the role the run pinned at start.
   * Narrow-only, so an absent map (or an absent role) leaves the decision exactly where the base
   * rules put it.
   */
  classRulesByRole?: ClassRulesByRole
  /**
   * Per-role allowlist of the change classes this preset will land at all. Orthogonal to
   * {@link classRulesByRole} and applied ABOVE it: a class the rules would auto-merge is still
   * refused when it is outside the initiator's allowlist. An absent map (or an absent role
   * entry) is unrestricted.
   */
  submissionClassesByRole?: SubmissionClassesByRole
}

/**
 * What the review card this resolver raises needs to know beyond the assessment itself: how the
 * diff classified, the track-record row to link, and whether the run was SANDBOXED (which changes
 * what the card says held the PR back, not merely whether it says so).
 */
interface ReviewCardContext {
  changeClass: ChangeClass
  recordId?: string
  dryRun?: boolean
  /**
   * The initiator's role may not land this class of change. Like `dryRun` it changes what the
   * card says held the PR back, and for the same reason: the scores were never consulted, so a
   * card describing them would send the reader to edit a ceiling that had no part in it.
   */
  submissionBlocked?: boolean
}

/**
 * Everything the auto-merge precedence ladder decides on, gathered so the ladder itself can be one
 * pure function rather than a pair of nested ternaries inside the resolver.
 */
interface MergePrecedenceInput {
  /** The run was SANDBOXED: it may land nothing, whatever the policy says. */
  dryRun: boolean
  /** The initiator's role may land this change class (true when nothing scopes them). */
  submissionAllowed: boolean
  /** The preset's master switch. */
  autoMergeEnabled: boolean
  /** The class rule as narrowed by the initiator's role. */
  effectiveRule: MergeClassRule
  /** The role's entry is what produced `effectiveRule` (it is stricter than the base rule). */
  narrowedByRole: boolean
  /** The merger produced a parseable assessment at all. */
  hasAssessment: boolean
  /** ...and explained it, which is the backstop against a bogus 0/0/0 auto-merging. */
  credible: boolean
  /** Every axis is at or below its ceiling. */
  withinThresholds: boolean
}

/** What the ladder decides: merge, or leave it for a human and say precisely why. */
interface MergePrecedenceVerdict {
  merge: boolean
  /** The reason to record when the merge lands (unused when `merge` is false). */
  mergeReason: MergeDecision['reason']
  /** The reason to record when it does not (unused when `merge` is true). */
  reviewReason: MergeDecision['reason']
}

/**
 * The auto-merge precedence ladder, most-significant first:
 *
 *   1. A DRY RUN merges nothing, whatever else says. It outranks even `autoMergeEnabled` because
 *      it is a property of the RUN rather than of the policy: the person who started it was never
 *      authorised to land this work, so no preset can consent on their behalf.
 *   2. The initiator's SUBMISSION ALLOWLIST, when their role carries one and this run's class is
 *      outside it. Beside `dry_run` and above the master switch for the same reason: it is about
 *      WHO started the run. What separates it from a `never` class rule is that it also refuses
 *      the MANUAL merge, so it is a bar on landing rather than a demand for review.
 *   3. `autoMergeEnabled: false`, the master switch. "Manual review only" stays manual and a
 *      class rule can NEVER override it.
 *   4. The class rule AS NARROWED BY THE INITIATOR'S ROLE: `always` merges regardless of the
 *      scores, and regardless of the rationale backstop, because an explicit operator policy
 *      keyed on a DETERMINISTIC backend classification outranks the agent's self-report; `never`
 *      always routes to a human. A role entry can only push this arm toward `never`.
 *   5. The credibility + threshold comparison.
 *
 * The review reason is derived HERE, in the same order and from the same inputs, because the two
 * used to be written twice and the pair has to agree: a decision that declines to merge on one
 * rung and blames another sends the reader to edit a setting that had no part in the outcome.
 * Every rung is kept apart from its neighbours because each needs a DIFFERENT fix. `dry_run` is
 * fixed by re-running live, `submission_not_allowed` by a teammate on a permitted tier or a wider
 * allowlist, `role_requires_review` by any reviewer, `class_requires_review` by editing the class
 * rule, and `no_rationale` (scores but no explanation) is not `no_assessment` (no scores at all).
 */
function resolveMergePrecedence(input: MergePrecedenceInput): MergePrecedenceVerdict {
  const { effectiveRule } = input
  const merge =
    !input.dryRun &&
    input.submissionAllowed &&
    input.autoMergeEnabled &&
    (effectiveRule === 'always' ||
      (effectiveRule !== 'never' && input.credible && input.withinThresholds))
  return {
    merge,
    mergeReason: effectiveRule === 'always' ? 'class_auto_merge' : 'within_thresholds',
    reviewReason: reviewReasonFor(input),
  }
}

/** Why review is needed, in the same order {@link resolveMergePrecedence} applies. */
function reviewReasonFor(input: MergePrecedenceInput): MergeDecision['reason'] {
  if (input.dryRun) return 'dry_run'
  if (!input.submissionAllowed) return 'submission_not_allowed'
  if (!input.autoMergeEnabled) return 'auto_merge_disabled'
  if (input.effectiveRule === 'never') {
    return input.narrowedByRole ? 'role_requires_review' : 'class_requires_review'
  }
  if (!input.hasAssessment) return 'no_assessment'
  return input.credible ? 'exceeded_thresholds' : 'no_rationale'
}

/** The assessment axes that exceed their preset ceiling (empty when all are within). */
function exceededAxesOf(assessment: MergeAssessment, preset: MergeThresholds): MergeAxis[] {
  const axes: MergeAxis[] = []
  if (assessment.complexity > preset.maxComplexity) axes.push('complexity')
  if (assessment.risk > preset.maxRisk) axes.push('risk')
  if (assessment.impact > preset.maxImpact) axes.push('impact')
  return axes
}

/**
 * The outcome of {@link MergeResolverDeps.finalizeMerge} — a task's real merge over ALL its
 * pull requests (own-service + peers). A complete failure (nothing merged) still THROWS, so
 * the single-repo path is unchanged (the resolver's catch falls back to a review card); a
 * `partial` result means some PRs merged and a later one failed — cross-repo merges are
 * non-atomic — which `finalizeMerge` already surfaced (block `blocked` + an enumerated
 * notification), so the resolver only labels the decision.
 */
export type FinalizeMergeResult =
  | { kind: 'merged' }
  | { kind: 'partial'; merged: string[]; unmerged: string[] }

/** The engine collaborators the merge resolver drives (kept on the engine, shared elsewhere). */
export interface MergeResolverDeps {
  blockRepository: BlockRepository
  notificationService?: NotificationService
  /** The task's resolved merge-threshold preset (block pin → workspace default → built-in). */
  resolveRiskPolicy: (workspaceId: string, block: Block) => Promise<MergeThresholds>
  /**
   * Merge the block's PR(s) for real then flip it `done` — throws on a COMPLETE failure
   * (nothing merged), returns `partial` when a multi-repo merge merged some then hit a
   * failure (block left `blocked` + notified), else `merged`.
   */
  finalizeMerge: (workspaceId: string, blockId: string) => Promise<FinalizeMergeResult>
  /**
   * The merge track record — classification (which the per-class rule keys off) plus the
   * best-effort record of the decision. Absent (no repository wired / tests) ⇒ the class
   * resolves `unknown`, no rule matches, nothing is persisted, and the resolver behaves exactly
   * as it did before this existed.
   */
  mergeTrackRecord?: MergeTrackRecordService
}

/**
 * Resolves a `merger` step's assessment into the run's terminal merge outcome: parse +
 * validate it, compare each axis against the task's resolved merge preset, and either merge
 * the PR for real (all within threshold AND the assessment is credibly explained) or raise a
 * `merge_review` notification leaving the block `pr_ready`. Extracted out of `ExecutionService`
 * so the merge policy lives in one focused place; the actual remote merge + the preset lookup
 * stay on the engine (shared by the CI gate and the review gates) and are injected.
 */
export class MergeResolver {
  constructor(private readonly deps: MergeResolverDeps) {}

  /**
   * Resolve a completed `merger` step into the terminal merge outcome AND a structured
   * {@link MergeDecision} the caller records on the step (`step.custom`) so the SPA can
   * render the assessment + explain WHY the engine auto-merged or asked for review. Returns
   * null only when the run's block can't be loaded (nothing to record).
   */
  async resolveMergerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    rawAssessment: unknown,
  ): Promise<MergeDecision | null> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return null
    // Replay guard: a durable-driver retry can re-resolve a merger step whose merge
    // already landed (crash between the real merge and the instance persist). `done`
    // is terminal-and-merged — never re-merge, and never downgrade it to `pr_ready`
    // with a spurious review notification.
    if (block.status === 'done') return null

    let assessment: MergeAssessment | null = null
    try {
      assessment = parseMergeAssessment(rawAssessment)
    } catch {
      assessment = null
    }

    const preset = await this.deps.resolveRiskPolicy(workspaceId, block)

    // Classify the PR BEFORE deciding: the preset's per-class rule can short-circuit the score
    // comparison entirely. One VCS call, swallowed on any failure into `unknown` — which no rule
    // matches — so a classification fault can neither widen nor tighten the policy, and can
    // never fail the merge. The result is threaded into the record write so we never pay twice.
    const classification = (await this.deps.mergeTrackRecord?.classify(workspaceId, block)) ?? {
      changeClass: 'unknown' as ChangeClass,
      fileCount: 0,
    }
    // The class rule, then that rule NARROWED by the tier the run was admitted under. Narrowing is
    // subtractive by construction (see `narrowMergeClassRule`), so this can only ever move the
    // decision toward review — it cannot hand a role something the preset withholds, and a run
    // with no pinned role comes back exactly as it did before role scoping existed.
    const {
      base: classRule,
      effective: effectiveRule,
      narrowedByRole,
    } = resolveRoleScopedMergeClassRule({
      rules: preset.classRules,
      byRole: preset.classRulesByRole,
      role: instance.initiatedByRole,
      changeClass: classification.changeClass,
    })
    // Whether this run may land ANYTHING. Read off the run rather than re-derived from the preset:
    // the mode was settled and pinned at start, so a preset edited mid-flight cannot un-sandbox a
    // run a human is already reviewing (nor sandbox one that has been merging all along).
    const dryRun = isDryRun(instance.mode)
    // Whether this run's TIER may land this KIND of change at all. Read alongside the class rule
    // rather than folded into it: the two are orthogonal and both apply, and this one is a bar on
    // landing where a class rule only decides how much review landing takes. `unknown` passes
    // straight through (an unreadable diff is an outage, not evidence), as does a role with no
    // authored allowlist and a run with no pinned role at all.
    const submissionAllowlist = submissionAllowlistForRole(
      preset.submissionClassesByRole,
      instance.initiatedByRole,
    )
    const submissionAllowed = submissionAllowedForRole(
      preset.submissionClassesByRole,
      instance.initiatedByRole,
      classification.changeClass,
    )

    const thresholds: MergeDecision['thresholds'] = {
      presetName: preset.name,
      maxComplexity: preset.maxComplexity,
      maxRisk: preset.maxRisk,
      maxImpact: preset.maxImpact,
      autoMergeEnabled: preset.autoMergeEnabled,
      ...(classRule !== 'thresholds' ? { classRule } : {}),
      ...(instance.initiatedByRole ? { initiatorRole: instance.initiatedByRole } : {}),
      // Recorded only when the role CHANGED the outcome, so its presence always means "this
      // would have gone differently for someone else" rather than "a role was involved".
      ...(narrowedByRole ? { roleRule: effectiveRule } : {}),
      // Recorded whenever the role IS scoped, not only when the scope refused this PR: an
      // allowlist that permitted this class is what explains why the same role's next PR on
      // another class will not land, and reporting it only on the refusal would make the
      // permission read as an absence of policy.
      ...(submissionAllowlist ? { submissionClasses: [...submissionAllowlist] } : {}),
    }
    const base = {
      assessment: assessment ?? undefined,
      thresholds,
      ...(classification.changeClass !== 'unknown'
        ? { changeClass: classification.changeClass }
        : {}),
    } as const
    // A credible assessment explains itself: a merger that actually examined the diff always
    // returns a rationale, while a merger that failed to inspect the change (the bug that
    // auto-merged on a bogus 0/0/0) returns bare, unexplained scores. The non-empty rationale
    // check is the engine-side backstop so those can never silently merge.
    const credible = assessment !== null && assessment.rationale.trim() !== ''
    const exceededAxes = assessment ? exceededAxesOf(assessment, preset) : []

    const {
      merge: within,
      mergeReason,
      reviewReason,
    } = resolveMergePrecedence({
      dryRun,
      submissionAllowed,
      autoMergeEnabled: preset.autoMergeEnabled,
      effectiveRule,
      narrowedByRole,
      hasAssessment: assessment !== null,
      credible,
      withinThresholds: exceededAxes.length === 0,
    })

    // What a review card this outcome raises needs beyond the assessment. Built once: the two
    // raise sites below differ only in WHY they were reached, and a card that named a different
    // cause on the merge-failure path than on the refusal path would be reporting the resolver's
    // control flow rather than the run's policy.
    const cardContext = (recordId?: string): ReviewCardContext => ({
      changeClass: classification.changeClass,
      ...(recordId ? { recordId } : {}),
      dryRun,
      submissionBlocked: !submissionAllowed,
    })

    const record = (decision: 'auto_merged' | 'pending_review') =>
      this.deps.mergeTrackRecord?.recordDecision(workspaceId, {
        block,
        executionId: instance.id,
        decision,
        assessment,
        riskPolicyId: preset.id ?? null,
        riskPolicyName: preset.name,
        classification,
      })

    if (within) {
      try {
        const res = await this.deps.finalizeMerge(workspaceId, block.id)
        if (res.kind === 'partial') {
          // A multi-repo task merged some PRs but hit a failure part-way; `finalizeMerge`
          // already left the block `blocked` and raised the enumerated partial-merge card, so
          // the resolver only records the decision (no second review notification).
          await record('pending_review')
          return { ...base, outcome: 'awaiting_review', reason: 'merge_partial', exceededAxes: [] }
        }
        await record('auto_merged')
        return { ...base, outcome: 'auto_merged', reason: mergeReason, exceededAxes: [] }
      } catch {
        // Auto-merge failed outright (e.g. branch protection / conflict, or the first PR of a
        // multi-repo task): fall through to a review notification so a human can sort it out.
        const pending = await record('pending_review')
        await this.raiseReviewAndBlock(
          workspaceId,
          instance,
          block,
          assessment,
          cardContext(pending?.id),
        )
        return { ...base, outcome: 'awaiting_review', reason: 'merge_failed', exceededAxes }
      }
    }

    const pending = await record('pending_review')
    await this.raiseReviewAndBlock(
      workspaceId,
      instance,
      block,
      assessment,
      cardContext(pending?.id),
    )
    return { ...base, outcome: 'awaiting_review', reason: reviewReason, exceededAxes }
  }

  /**
   * The track-record context a review card carries so the human can tag in the same tap.
   *
   * Takes only what it PROJECTS. `dryRun` rides the same {@link ReviewCardContext} the callers
   * thread, but it changes the card's WORDING rather than its track-record link, so naming it
   * here would advertise an input this function has no use for.
   */
  private readonly trackContext = (ctx: ReviewCardContext) => ({
    ...(ctx.changeClass !== 'unknown' ? { changeClass: ctx.changeClass } : {}),
    ...(ctx.recordId ? { mergeTrackRecordId: ctx.recordId } : {}),
  })

  /**
   * Raise the merge-review notification, THEN flip the block to `pr_ready`.
   *
   * The order is load-bearing. The card is the only actionable prompt this outcome produces —
   * nothing re-drives a review, and the sweepers never see a non-`running` run — while the
   * block status is merely how the board paints the task. Flipping first meant a raise that
   * threw left a `pr_ready` block with no inbox card: a task that LOOKS finished-and-waiting,
   * masking the failed run behind it. Raising first inverts the surviving failure into the
   * honest one — the run fails, the block stays where it was, and the failure is visible on the
   * board (retryable) rather than dressed up as a PR awaiting review. The new failure window
   * this opens (card raised, flip failed) costs nothing on a replay: `NotificationService.raise`
   * de-dupes the open card on (workspace, block, type), so the re-drive reuses the same row.
   */
  private async raiseReviewAndBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
    track: ReviewCardContext,
  ): Promise<void> {
    await this.raiseMergeReview(workspaceId, instance, block, assessment, track)
    await this.deps.blockRepository.update(workspaceId, block.id, {
      status: 'pr_ready',
      progress: 1,
    })
  }

  /** Raise a `merge_review` notification carrying the agent's assessment + the PR. */
  private async raiseMergeReview(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
    track: ReviewCardContext,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    // A sandboxed run's card must not describe the scores as the thing holding the PR back: they
    // were never consulted, and a card blaming them sends the reader to edit a ceiling that had
    // no part in the outcome. Report the assessment as the INFORMATION it is on a dry run, and
    // say plainly why nothing merged.
    const scores = assessment
      ? `complexity ${pct(assessment.complexity)}, risk ${pct(assessment.risk)}, ` +
        `impact ${pct(assessment.impact)}`
      : null
    const body = track.dryRun
      ? `This was a dry run, so its PR was left open for a human regardless of the assessment.` +
        (scores && assessment ? ` The merger scored it ${scores}. ${assessment.rationale}` : '')
      : // Same rule as the sandbox: name the policy that actually held the PR back rather than
        // the scores nobody consulted. It deliberately does NOT claim the change cannot land: the
        // PR is real, and a teammate whose role may land this class can merge it from here.
        track.submissionBlocked
        ? `This task's merge policy does not let the role that started this run land ` +
          `${track.changeClass === 'unknown' ? 'this' : `a \`${track.changeClass}\``} change, so ` +
          `its PR was left open regardless of the assessment.` +
          (scores && assessment ? ` The merger scored it ${scores}. ${assessment.rationale}` : '')
        : assessment
          ? `The merger scored this PR outside the task's auto-merge thresholds ` +
            `(${scores}). ${assessment.rationale}`
          : `The merger could not produce a valid assessment for this PR. Review and merge manually.`
    await this.deps.notificationService.raise(workspaceId, {
      type: 'merge_review',
      blockId: block.id,
      executionId: instance.id,
      title: `Review PR for "${block.title}"`,
      body,
      payload: {
        ...(assessment ? { assessment } : {}),
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
        // The change class + the record id, so the card can show what kind of change this is
        // (with that class's history) and confirm-plus-tag it in one tap.
        ...this.trackContext(track),
      },
    })
  }
}
