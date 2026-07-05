import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  MergeAssessment,
  MergeAxis,
  MergeDecision,
} from '@cat-factory/kernel'
import { parseMergeAssessment } from '@cat-factory/contracts'
import type { NotificationService } from '../notifications/NotificationService.js'

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** The auto-merge ceilings the resolver compares a merger assessment against. */
interface MergeThresholds {
  /** The resolved preset's display name (block pin → workspace default → built-in). */
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  /** When false, auto-merge is disabled outright — every PR is routed to human review. */
  autoMergeEnabled: boolean
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
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<MergeThresholds>
  /**
   * Merge the block's PR(s) for real then flip it `done` — throws on a COMPLETE failure
   * (nothing merged), returns `partial` when a multi-repo merge merged some then hit a
   * failure (block left `blocked` + notified), else `merged`.
   */
  finalizeMerge: (workspaceId: string, blockId: string) => Promise<FinalizeMergeResult>
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

    const preset = await this.deps.resolveMergePreset(workspaceId, block)
    const thresholds: MergeDecision['thresholds'] = {
      presetName: preset.name,
      maxComplexity: preset.maxComplexity,
      maxRisk: preset.maxRisk,
      maxImpact: preset.maxImpact,
      autoMergeEnabled: preset.autoMergeEnabled,
    }
    const base = { assessment: assessment ?? undefined, thresholds } as const
    // A credible assessment explains itself: a merger that actually examined the diff always
    // returns a rationale, while a merger that failed to inspect the change (the bug that
    // auto-merged on a bogus 0/0/0) returns bare, unexplained scores. The non-empty rationale
    // check is the engine-side backstop so those can never silently merge.
    const credible = assessment !== null && assessment.rationale.trim() !== ''
    const exceededAxes = assessment ? exceededAxesOf(assessment, preset) : []

    // Auto-merge only when the preset ALLOWS it AND the assessment is a CREDIBLE
    // within-threshold one. A "manual review only" preset (`autoMergeEnabled: false`)
    // short-circuits, so every PR is routed to human review regardless of scores.
    const within = preset.autoMergeEnabled && credible && exceededAxes.length === 0

    if (within) {
      try {
        const res = await this.deps.finalizeMerge(workspaceId, block.id)
        if (res.kind === 'partial') {
          // A multi-repo task merged some PRs but hit a failure part-way; `finalizeMerge`
          // already left the block `blocked` and raised the enumerated partial-merge card, so
          // the resolver only records the decision (no second review notification).
          return { ...base, outcome: 'awaiting_review', reason: 'merge_partial', exceededAxes: [] }
        }
        return { ...base, outcome: 'auto_merged', reason: 'within_thresholds', exceededAxes: [] }
      } catch {
        // Auto-merge failed outright (e.g. branch protection / conflict, or the first PR of a
        // multi-repo task): fall through to a review notification so a human can sort it out.
        await this.raiseReviewAndBlock(workspaceId, instance, block, assessment)
        return { ...base, outcome: 'awaiting_review', reason: 'merge_failed', exceededAxes }
      }
    }

    await this.raiseReviewAndBlock(workspaceId, instance, block, assessment)
    // Classify WHY review is needed, most-specific first, so the banner is precise. A
    // missing/unparseable assessment (`no_assessment`) is distinct from one that returned
    // scores but no rationale (`no_rationale`): the latter DID produce visible scores, so
    // the banner must not claim there was no assessment at all.
    const reason: MergeDecision['reason'] = !preset.autoMergeEnabled
      ? 'auto_merge_disabled'
      : assessment === null
        ? 'no_assessment'
        : !credible
          ? 'no_rationale'
          : 'exceeded_thresholds'
    return { ...base, outcome: 'awaiting_review', reason, exceededAxes }
  }

  /** Flip the block to `pr_ready` and raise the merge-review notification. */
  private async raiseReviewAndBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
  ): Promise<void> {
    await this.deps.blockRepository.update(workspaceId, block.id, {
      status: 'pr_ready',
      progress: 1,
    })
    await this.raiseMergeReview(workspaceId, instance, block, assessment)
  }

  /** Raise a `merge_review` notification carrying the agent's assessment + the PR. */
  private async raiseMergeReview(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const body = assessment
      ? `The merger scored this PR outside the task's auto-merge thresholds ` +
        `(complexity ${pct(assessment.complexity)}, risk ${pct(assessment.risk)}, ` +
        `impact ${pct(assessment.impact)}). ${assessment.rationale}`
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
      },
    })
  }
}
