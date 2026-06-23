import type { ConsensusGating, TaskEstimate } from '@cat-factory/kernel'

// Pure gating decision: should an eligible, consensus-enabled step actually run the
// (expensive) multi-model process, or fall back to the standard single-actor agent?
// Kept pure for unit testing.

export type ConsensusMode = 'consensus' | 'standard'

/**
 * Decide whether to run consensus given the task estimate and the step's gating config.
 *
 *  - No gating / gating disabled → always `consensus` (the user opted in unconditionally).
 *  - Gating enabled, estimate present → `consensus` iff ANY supplied axis is met or
 *    exceeded (risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥ minComplexity).
 *    A gating block with no thresholds set never triggers on score (so it falls to
 *    `standard`) — configuring gating means you must give it at least one bar.
 *  - Gating enabled, estimate absent → `gating.onMissingEstimate` (default `consensus`,
 *    fail-safe to thoroughness: we couldn't prove the task is low-stakes).
 */
export function decideConsensusMode(
  estimate: TaskEstimate | null | undefined,
  gating: ConsensusGating | undefined,
): ConsensusMode {
  if (!gating || !gating.enabled) return 'consensus'
  if (!estimate) return gating.onMissingEstimate ?? 'consensus'

  const axes: Array<[number | undefined, number]> = [
    [gating.minComplexity, estimate.complexity],
    [gating.minRisk, estimate.risk],
    [gating.minImpact, estimate.impact],
  ]
  for (const [threshold, value] of axes) {
    if (threshold !== undefined && value >= threshold) return 'consensus'
  }
  return 'standard'
}
