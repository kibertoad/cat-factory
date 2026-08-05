import type { PipelineStep, StepGating, TaskEstimate } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { isCompanionKind } from '@cat-factory/agents'

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

/**
 * Whether `step` is a COMPANION whose producer was skipped, and must therefore be skipped too.
 *
 * A companion reviews the step immediately before it (`assertValidCompanionPlacement` guarantees
 * that adjacency over the enabled subset). Once a PRODUCER can itself be estimate-gated, a
 * companion can arrive with nothing to review: skipping `architect` on a light task would leave
 * `architect-companion` grading whichever step happens to precede it — silently rating the wrong
 * artifact rather than failing.
 *
 * Deliberately a LOCAL rule evaluated at the companion's own turn rather than a lookahead that
 * skips two steps at once:
 *
 *  - it reads PERSISTED state (`prior.skipped`), so it survives a durable-driver replay — an
 *    in-memory "I intend to skip the next one too" would not;
 *  - it composes with the companion's OWN gate (either reason skips it, and the reasons don't
 *    have to agree);
 *  - it needs no knowledge of which producer the companion targets, because adjacency is already
 *    an invariant the shape validation enforces.
 *
 * `steps`/`index` are the run's step list and this step's position in it. Index 0 can never be a
 * companion (it would have no producer, which the shape validation rejects), so a missing
 * predecessor yields `false` rather than a skip.
 */
export function producerWasSkipped(
  steps: readonly PipelineStep[],
  index: number,
  registry?: AgentKindRegistry,
): boolean {
  const step = steps[index]
  if (!step || !isCompanionKind(step.agentKind, registry)) return false
  return steps[index - 1]?.skipped === true
}
