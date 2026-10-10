import type { AgentEffortReport } from '~/types/execution'

/**
 * Presentation helpers for a container agent's effort self-assessment
 * (`PipelineStep.effortReport` — how hard the work was, what reduced its effectiveness,
 * the obstacles it hit). Shared by the two surfaces that render it: the full card in the
 * generic step-detail panel (`StepEffortReport.vue`) and the collapsible footer every
 * dedicated result window gets from `ResultWindowShell.vue`. The band thresholds live
 * here so the two can't drift into disagreeing about what counts as a hard run.
 */

/** The difficulty band a 1..10 self-rating falls into. */
export type EffortBand = 'easy' | 'moderate' | 'hard'

/** Band a report's difficulty: 1-4 easy, 5-7 moderate, 8-10 hard. */
export function effortBand(difficulty: number): EffortBand {
  if (difficulty >= 8) return 'hard'
  if (difficulty >= 5) return 'moderate'
  return 'easy'
}

/**
 * The one-line gist for a collapsed footer row: what held the agent back, else its
 * summary of the work. Null when the agent rated the run but wrote no prose, so the
 * row falls back to the difficulty chip alone.
 */
export function effortHint(report: AgentEffortReport): string | null {
  return report.reducedEffectiveness ?? report.summary ?? null
}
