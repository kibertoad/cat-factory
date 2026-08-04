import type {
  Block,
  BlockRepository,
  ChangeClass,
  ClassRulesByRole,
  ExecutionInstance,
  MergeAssessment,
  MergeAxis,
  MergeClassRules,
  MergeDecision,
} from '@cat-factory/kernel'
import { parseMergeAssessment } from '@cat-factory/contracts'
import { resolveRoleScopedMergeClassRule } from '@cat-factory/kernel'
import { isDryRun } from './runMode.logic.js'
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

    // Auto-merge precedence, most-significant first:
    //   1. A DRY RUN merges nothing, whatever else says. It outranks even `autoMergeEnabled`
    //      because it is a property of the RUN rather than of the policy: the person who started
    //      it was never authorised to land this work, so no preset can consent on their behalf.
    //   2. `autoMergeEnabled: false` — the master switch. "Manual review only" stays manual and
    //      a class rule can NEVER override it.
    //   3. The class rule AS NARROWED BY THE INITIATOR'S ROLE: `always` merges regardless of the
    //      scores (and regardless of the rationale backstop — an explicit operator policy keyed on
    //      a DETERMINISTIC backend classification outranks the agent's self-report); `never`
    //      always routes to a human. A role entry can only push this arm toward `never`.
    //   4. The existing credibility + threshold comparison.
    const within =
      !dryRun &&
      preset.autoMergeEnabled &&
      (effectiveRule === 'always' ||
        (effectiveRule !== 'never' && credible && exceededAxes.length === 0))
    const mergeReason: MergeDecision['reason'] =
      effectiveRule === 'always' ? 'class_auto_merge' : 'within_thresholds'

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
        await this.raiseReviewAndBlock(workspaceId, instance, block, assessment, {
          changeClass: classification.changeClass,
          recordId: pending?.id,
          dryRun,
        })
        return { ...base, outcome: 'awaiting_review', reason: 'merge_failed', exceededAxes }
      }
    }

    const pending = await record('pending_review')
    await this.raiseReviewAndBlock(workspaceId, instance, block, assessment, {
      changeClass: classification.changeClass,
      recordId: pending?.id,
      dryRun,
    })
    // Classify WHY review is needed, most-specific first, so the banner is precise, in the SAME
    // order the auto-merge branch above applies. A missing/unparseable assessment
    // (`no_assessment`) is distinct from one that returned scores but no rationale
    // (`no_rationale`): the latter DID produce visible scores, so the banner must not claim there
    // was no assessment at all.
    //
    // `dry_run` tops the ladder for the reason it tops the precedence: a sandboxed run's scores
    // were never consulted, so reporting it as `exceeded_thresholds` (or as `auto_merge_disabled`,
    // on a preset that would happily have merged it) sends someone to edit a ceiling that had no
    // part in the outcome. `role_requires_review` is likewise kept apart from
    // `class_requires_review` even though both mean "the rule says never": one is fixed by editing
    // the class rule, the other by a teammate on a higher tier merging the PR as it stands.
    const reason: MergeDecision['reason'] = dryRun
      ? 'dry_run'
      : !preset.autoMergeEnabled
        ? 'auto_merge_disabled'
        : effectiveRule === 'never'
          ? narrowedByRole
            ? 'role_requires_review'
            : 'class_requires_review'
          : assessment === null
            ? 'no_assessment'
            : !credible
              ? 'no_rationale'
              : 'exceeded_thresholds'
    return { ...base, outcome: 'awaiting_review', reason, exceededAxes }
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
