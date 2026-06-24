import type { StepGating, TaskEstimate } from '@cat-factory/kernel'

/**
 * Decide whether a gated pipeline step should run, given the task estimate and the step's
 * gating config. Mirrors the consensus-gating decision (OR across axes) but yields a plain
 * run/skip:
 *
 *  - No gating / gating disabled → run (the step is unconditional).
 *  - Gating enabled, estimate present → run iff ANY supplied axis is met or exceeded
 *    (risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥ minComplexity). A gating block
 *    with no thresholds set never triggers on score → skip.
 *  - Gating enabled, estimate absent → `gating.onMissingEstimate` (default `run`, fail-safe
 *    to thoroughness).
 */
export function shouldRunGatedStep(
  estimate: TaskEstimate | null | undefined,
  gating: StepGating | null | undefined,
): boolean {
  if (!gating || !gating.enabled) return true
  if (!estimate) return (gating.onMissingEstimate ?? 'run') === 'run'
  const axes: Array<[number | undefined, number]> = [
    [gating.minComplexity, estimate.complexity],
    [gating.minRisk, estimate.risk],
    [gating.minImpact, estimate.impact],
  ]
  for (const [threshold, value] of axes) {
    if (threshold !== undefined && value >= threshold) return true
  }
  return false
}
