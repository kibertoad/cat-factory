import type {
  Block,
  BlockRepository,
  ChangeClass,
  ClassRulesByRole,
  ExecutionInstance,
  MergeAssessment,
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
import {
  exceededAxesOf,
  isCredibleAssessment,
  resolveMergePrecedence,
  type MergeCeilings,
  type ReviewCardReason,
} from '../merge/mergePrecedence.js'
import type { RunPolicyScope } from './policy-types.js'

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** How a card names the kind of change, when the diff was readable enough to classify it. */
function changeClassPhrase(changeClass: ChangeClass): string {
  return changeClass === 'unknown' ? 'this' : `a \`${changeClass}\``
}

/** The auto-merge ceilings the resolver compares a merger assessment against. */
interface MergeThresholds extends MergeCeilings {
  /** The resolved preset's id, absent when the built-in constant fallback was used. */
  id?: string
  /** The resolved preset's display name (block pin → workspace default → built-in). */
  name: string
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
 * diff classified, the track-record row to link, and WHY review was needed.
 *
 * The reason is the decision's own, not a set of flags re-derived beside it. Each rung of the
 * precedence ladder refuses for a cause with its own remedy, and a card that described a
 * different one would send the reader to edit a setting that took no part in the outcome: the
 * exact failure the ladder itself was written to stop. Carrying booleans instead meant the card
 * only knew about the rungs somebody had remembered to add one for, and everything else fell
 * through to a sentence blaming the thresholds.
 */
interface ReviewCardContext {
  changeClass: ChangeClass
  recordId?: string
  reason: ReviewCardReason
}

/**
 * The sentence each refusal leads with. Exhaustive over {@link ReviewCardReason} by type, so the
 * next rung cannot ship wearing a neighbour's wording.
 *
 * Only `exceeded_thresholds` may blame the ceilings, because it is the only reason a ceiling
 * decided. Every other arm says what actually refused and leaves the scores to the tail
 * {@link reviewCardBody} appends, where they read as the information they are rather than as the
 * thing to go and change.
 */
const REVIEW_CARD_LEAD: Record<ReviewCardReason, (ctx: ReviewCardContext) => string> = {
  dry_run: () =>
    `This was a dry run, so its PR was left open for a human regardless of the assessment.`,
  submission_not_allowed: (ctx) =>
    `This task's merge policy does not let the role that started this run land ` +
    `${changeClassPhrase(ctx.changeClass)} change, so its PR was left open regardless of the ` +
    `assessment.`,
  auto_merge_disabled: () =>
    `This task's merge policy routes every pull request to a human, so this one was left open ` +
    `regardless of the assessment.`,
  // The one refusal whose remedy is not a setting to edit: nothing was configured to edit. It
  // says so plainly and names no ceiling, because the fallback's ceilings are pinned to 0 and
  // took no part in this (they would read as the strictest policy in the product).
  no_policy_configured: () =>
    `No merge policy governed this run, so nothing merged on its own and this PR was left open ` +
    `for a human. This deployment has no merge preset library wired, so none of the task's ` +
    `auto-merge ceilings took part in the decision.`,
  role_requires_review: (ctx) =>
    `This task's merge policy asks a human to review ${changeClassPhrase(ctx.changeClass)} ` +
    `change from the role that started this run, so its PR was left open regardless of the ` +
    `assessment.`,
  class_requires_review: (ctx) =>
    `This task's merge policy asks a human to review ${changeClassPhrase(ctx.changeClass)} ` +
    `change, so its PR was left open regardless of the assessment.`,
  no_rationale: () =>
    `The merger returned scores but did not explain them, so its verdict was not trusted to ` +
    `merge this PR on its own.`,
  no_assessment: () =>
    `The merger could not produce a valid assessment for this PR. Review and merge manually.`,
  exceeded_thresholds: () => `The merger scored this PR outside the task's auto-merge thresholds.`,
  merge_failed: () =>
    `The automatic merge for this PR did not go through, so it was left open for a human.`,
}

/**
 * The review card's body: why review was needed, then the assessment as supporting information.
 *
 * The scores ride the SAME tail on every reason so they never have to double as the explanation.
 * A rationale is appended only when the merger wrote one, which is exactly what `no_rationale`
 * reports the absence of.
 */
function reviewCardBody(ctx: ReviewCardContext, assessment: MergeAssessment | null): string {
  const lead = REVIEW_CARD_LEAD[ctx.reason](ctx)
  if (!assessment) return lead
  const scores =
    `complexity ${pct(assessment.complexity)}, risk ${pct(assessment.risk)}, ` +
    `impact ${pct(assessment.impact)}`
  const rationale = assessment.rationale.trim()
  return `${lead} Its scores were ${scores}.${rationale ? ` ${rationale}` : ''}`
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
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<MergeThresholds>
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

    const preset = await this.deps.resolveRiskPolicy(workspaceId, block, instance)

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
    const credible = isCredibleAssessment(assessment)
    const exceededAxes = assessment ? exceededAxesOf(assessment, preset) : []

    const {
      merge: within,
      mergeReason,
      reviewReason,
    } = resolveMergePrecedence({
      dryRun,
      submissionAllowed,
      autoMergeEnabled: preset.autoMergeEnabled,
      // No id ⇒ the built-in fallback governed (see `MergeThresholds.id`), which is the one
      // policy no workspace has a row for.
      policyConfigured: preset.id !== undefined,
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
    const cardContext = (reason: ReviewCardReason, recordId?: string): ReviewCardContext => ({
      changeClass: classification.changeClass,
      ...(recordId ? { recordId } : {}),
      reason,
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
          cardContext('merge_failed', pending?.id),
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
      cardContext(reviewReason, pending?.id),
    )
    return { ...base, outcome: 'awaiting_review', reason: reviewReason, exceededAxes }
  }

  /**
   * The track-record context a review card carries so the human can tag in the same tap.
   *
   * Takes only what it PROJECTS. The `reason` rides the same {@link ReviewCardContext} the
   * callers thread, but it decides the card's WORDING rather than its track-record link, so
   * naming it here would advertise an input this function has no use for.
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
    // Worded from the DECISION's own reason: a card must name the thing that actually held the
    // PR back, or it sends the reader to edit a setting that took no part in the outcome. The
    // wording deliberately never claims the change cannot land: the PR is real, and a human who
    // may land it can merge it from here.
    const body = reviewCardBody(track, assessment)
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
