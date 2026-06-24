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
 *    spec-companion) must run IMMEDIATELY after an ENABLED step it can review. Companions are
 *    dependent agents — they make no sense without their producer — so the builder surfaces
 *    them as toggles attached to the producer (inserting them immediately after), and the
 *    validation enforces exactly that adjacency: a companion's nearest preceding enabled step
 *    must be one of its targets. (The engine still reviews the nearest preceding target, but
 *    that target is now guaranteed to be the immediate predecessor.)
 *  - {@link assertValidGating}: a step gated on the task estimate must be a companion (the
 *    only kind it is safe to skip — skipping a producer would starve its downstream steps),
 *    must set at least one axis threshold (or it would always skip), and needs a
 *    `task-estimator` to have run before it (or the gate has nothing to consult).
 */
export interface PipelineShape {
  agentKinds: string[]
  enabled?: boolean[]
  gating?: (StepGating | null)[]
}

export function validatePipelineShape(pipeline: PipelineShape): void {
  assertValidCompanionPlacement(pipeline.agentKinds, pipeline.enabled)
  assertValidGating(pipeline.agentKinds, pipeline.enabled, pipeline.gating)
}

/**
 * A companion step is only valid when the step IMMEDIATELY before it (over the enabled
 * subset) produces output it is allowed to review (a step whose kind is in the companion's
 * target allow-list). Validated over the enabled subset — that is exactly the chain the run
 * executes — so it also rejects "disable the producer but leave its companion on" (which
 * would leave the companion grading nothing at runtime) AND "slip another step between the
 * producer and its companion". Companions are surfaced in the builder as toggles attached to
 * their producer and run immediately after it, so adjacency is required.
 */
export function assertValidCompanionPlacement(agentKinds: string[], enabled?: boolean[]): void {
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind) || !isEnabled(i)) continue
    const targets = companionTargets(kind)
    // The nearest preceding ENABLED step must be a producer this companion can review.
    let predecessor: string | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (isEnabled(j)) {
        predecessor = agentKinds[j]
        break
      }
    }
    if (predecessor === undefined || !targets.includes(predecessor)) {
      throw new ValidationError(
        `Companion '${kind}' must run immediately after an enabled step it can review (${targets.join(', ')}).`,
      )
    }
  }
}

/**
 * Validate every ENABLED step that carries enabled estimate gating. A disabled gated step
 * never runs, so it imposes no requirement; an enabled one must satisfy all three rules:
 *
 *  1. The gated step must be a COMPANION kind. Gating means "skip this step when the task is
 *     light", and skipping is only safe for a dependent companion — skipping a producer
 *     (coder / spec-writer / architect) would leave its downstream steps (tester, merger,
 *     …) running against output that was never produced. (The consensus-gating sibling can
 *     degrade to the standard agent; step-gating removes the step, so it is companion-only.)
 *  2. It must set at least one axis threshold. With none, the axis loop in
 *     `shouldRunGatedStep` never matches, so a step with an estimate would ALWAYS skip — the
 *     opposite of the usual intent — making the toggle a silent footgun.
 *  3. An enabled `task-estimator` must run earlier in the chain, or the gate has no estimate
 *     to consult.
 */
export function assertValidGating(
  agentKinds: string[],
  enabled?: boolean[],
  gating?: (StepGating | null)[],
): void {
  if (!gating) return
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const g = gating[i]
    if (!g?.enabled || !isEnabled(i)) continue
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind)) {
      throw new ValidationError(
        `Step '${kind}' cannot be estimate-gated — only companion steps (reviewer / architect-companion / spec-companion) may be skipped on the estimate.`,
      )
    }
    if (g.minComplexity === undefined && g.minRisk === undefined && g.minImpact === undefined) {
      throw new ValidationError(
        `Step '${kind}' is estimate-gated but sets no threshold — set at least one of complexity / risk / impact, or it would always be skipped.`,
      )
    }
    const hasEstimator = agentKinds
      .slice(0, i)
      .some((k, j) => k === TASK_ESTIMATOR_AGENT_KIND && isEnabled(j))
    if (!hasEstimator) {
      throw new ValidationError(
        `Step '${kind}' is gated on the task estimate but no enabled '${TASK_ESTIMATOR_AGENT_KIND}' step runs before it. Add a task-estimator earlier in the pipeline.`,
      )
    }
  }
}
