import { ValidationError } from '@cat-factory/kernel'
import type { StepGating } from '@cat-factory/kernel'
import { companionTargets, isCompanionKind, TASK_ESTIMATOR_AGENT_KIND } from '@cat-factory/agents'

/**
 * Structural validation shared by the pipeline builder (save) and the execution engine
 * (run start), so a pipeline that is invalid is rejected at BOTH boundaries.
 *
 * A run is built from the ENABLED steps alone, executed consecutively, so both checks
 * reason over the enabled subset:
 *
 *  - {@link assertValidCompanionPlacement}: a companion (reviewer / architect-companion /
 *    spec-companion) must have some earlier ENABLED step it can review. Companions are
 *    dependent agents — they make no sense without their producer — so the builder surfaces
 *    them as toggles attached to the producer (inserting them immediately after). The
 *    validation only requires a preceding producer, NOT strict adjacency: the engine's
 *    companion reviews the NEAREST preceding target, which may legitimately sit a few steps
 *    back (e.g. `coder → tester → reviewer`), so tightening this to adjacency would reject a
 *    capability the engine supports.
 *  - {@link assertGatingRequiresEstimator}: a step gated on the task estimate needs a
 *    `task-estimator` to have run before it, or the gate has nothing to consult.
 */
export interface PipelineShape {
  agentKinds: string[]
  enabled?: boolean[]
  gating?: (StepGating | null)[]
}

export function validatePipelineShape(pipeline: PipelineShape): void {
  assertValidCompanionPlacement(pipeline.agentKinds, pipeline.enabled)
  assertGatingRequiresEstimator(pipeline.agentKinds, pipeline.enabled, pipeline.gating)
}

/**
 * A companion step is only valid when some EARLIER ENABLED step produces output it is
 * allowed to review (a step whose kind is in the companion's target allow-list). Validated
 * over the enabled subset — that is exactly the chain the run executes — so it also rejects
 * "disable the producer but leave its companion on", which would leave the companion grading
 * nothing at runtime. Not strict adjacency: the engine's companion reviews the NEAREST
 * preceding target, which may sit a few steps back.
 */
export function assertValidCompanionPlacement(agentKinds: string[], enabled?: boolean[]): void {
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind) || !isEnabled(i)) continue
    const targets = companionTargets(kind)
    const hasProducer = agentKinds.slice(0, i).some((k, j) => targets.includes(k) && isEnabled(j))
    if (!hasProducer) {
      throw new ValidationError(
        `Companion '${kind}' must run after an enabled step it can review (${targets.join(', ')}).`,
      )
    }
  }
}

/**
 * Any ENABLED step with enabled gating requires an enabled `task-estimator` earlier in the
 * chain — without one the gate can never read an estimate to decide on, so the pipeline is
 * rejected (at save and at start). A disabled gated step never runs, so it imposes no
 * requirement.
 */
export function assertGatingRequiresEstimator(
  agentKinds: string[],
  enabled?: boolean[],
  gating?: (StepGating | null)[],
): void {
  if (!gating) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    if (!gating[i]?.enabled || !isEnabled(i)) continue
    const hasEstimator = agentKinds
      .slice(0, i)
      .some((k, j) => k === TASK_ESTIMATOR_AGENT_KIND && isEnabled(j))
    if (!hasEstimator) {
      throw new ValidationError(
        `Step '${agentKinds[i]}' is gated on the task estimate but no enabled '${TASK_ESTIMATOR_AGENT_KIND}' step runs before it. Add a task-estimator earlier in the pipeline.`,
      )
    }
  }
}
