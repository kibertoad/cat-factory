import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  MergeAssessment,
} from '@cat-factory/kernel'
import { parseMergeAssessment } from '@cat-factory/contracts'
import type { NotificationService } from '../notifications/NotificationService.js'

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** The auto-merge ceilings the resolver compares a merger assessment against. */
interface MergeThresholds {
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  /** When false, auto-merge is disabled outright — every PR is routed to human review. */
  autoMergeEnabled: boolean
}

/** The engine collaborators the merge resolver drives (kept on the engine, shared elsewhere). */
export interface MergeResolverDeps {
  blockRepository: BlockRepository
  notificationService?: NotificationService
  /** The task's resolved merge-threshold preset (block pin → workspace default → built-in). */
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<MergeThresholds>
  /** Merge the block's PR for real then flip it `done` (throws on a blocked/failed merge). */
  finalizeMerge: (workspaceId: string, blockId: string) => Promise<void>
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

  async resolveMergerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    rawAssessment: unknown,
  ): Promise<void> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    // Replay guard: a durable-driver retry can re-resolve a merger step whose merge
    // already landed (crash between the real merge and the instance persist). `done`
    // is terminal-and-merged — never re-merge, and never downgrade it to `pr_ready`
    // with a spurious review notification.
    if (block.status === 'done') return

    let assessment: MergeAssessment | null = null
    try {
      assessment = parseMergeAssessment(rawAssessment)
    } catch {
      assessment = null
    }

    const preset = await this.deps.resolveMergePreset(workspaceId, block)
    // Auto-merge only when the preset ALLOWS it AND the assessment is a CREDIBLE
    // within-threshold one. A "manual review only" preset (`autoMergeEnabled: false`)
    // short-circuits here, so every PR is routed to human review regardless of scores.
    // A credible assessment explains itself: a merger that actually examined the diff
    // always returns a rationale, while a merger that failed to inspect the change (the
    // bug that auto-merged on a bogus 0/0/0) is forced upstream to a conservative,
    // explained verdict that fails the threshold. The non-empty rationale check is the
    // engine-side backstop so bare, unexplained scores can never silently merge.
    const within =
      preset.autoMergeEnabled &&
      assessment !== null &&
      assessment.rationale.trim() !== '' &&
      assessment.complexity <= preset.maxComplexity &&
      assessment.risk <= preset.maxRisk &&
      assessment.impact <= preset.maxImpact

    if (within) {
      try {
        await this.deps.finalizeMerge(workspaceId, block.id)
        return
      } catch {
        // Auto-merge failed (e.g. branch protection / conflict): fall through to a
        // review notification so a human can sort it out.
      }
    }

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
