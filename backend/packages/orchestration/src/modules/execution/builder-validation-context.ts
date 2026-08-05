import type { Block, ExecutionInstance, Logger, PipelineStep } from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import type { ResolvedReproduction, ResolvedValidationChecks } from '@cat-factory/contracts'
import { resolveReproductionSpec } from './reproductionProof.logic.js'

// ---------------------------------------------------------------------------
// The BUILDER's VERIFICATION-context resolvers, extracted from `AgentContextBuilder` as a
// cohesive collaborator (the file-size ratchet's split trigger). Both answer the same question
// from two sides: what will be run against the tree this dispatch produces, before the platform
// lets a pull request open. The pre-PR checks come from the service's stored configuration; the
// reproduction proof comes from the run's own prior `repro-test` declaration, and takes the
// checks' repair budget so an operator meets ONE attempt-budget concept rather than two.
//
// Both return a SPREAD-READY partial rather than a nullable, which is the shape every resolver in
// the builder's read wave uses: the fold at the `buildContext` call site is at its complexity
// ceiling and cannot afford a branch per field.
// ---------------------------------------------------------------------------

/** What {@link validationChecksFor} needs from the builder's dependency object. */
export interface ValidationContextDeps {
  /**
   * Resolve the frame's stored checks. Absent (unwired) is a normal deployment state and means
   * the same thing as a service that configured none.
   */
  resolveValidationChecks?: (
    workspaceId: string,
    frameId: string,
  ) => Promise<ResolvedValidationChecks | null>
  logger?: Logger
}

/**
 * The service frame's PRE-PR VALIDATION CHECKS, already shaped as a spread-ready fragment (`{}`
 * when the resolver is unwired, the block has no service frame, the service configured none, or
 * the read failed).
 *
 * Takes the frame `buildContext` ALREADY resolved (see `AgentContextBuilder.serviceFrameFor`),
 * like every other frame-scoped resolver in that wave, so the ancestry walk still runs exactly
 * once per dispatch rather than a second time just for this read.
 *
 * It also takes the STEP, because a failed read must be told apart from an unconfigured service
 * downstream and `{}` cannot carry that: the two are the same value and opposite facts. The flag
 * is written on the step (the same observability mutation `resolveFragments` makes under this
 * wave, persisted by the dispatch that follows), which is what lets the PR verification report say
 * the configuration could not be read instead of asserting the service declared nothing.
 */
export async function validationChecksFor(
  deps: ValidationContextDeps,
  workspaceId: string,
  frame: Block | null,
  step: PipelineStep,
): Promise<{ validationChecks?: ResolvedValidationChecks; dependencyInstall?: string }> {
  // Rewritten on EVERY dispatch, so a re-dispatch whose read succeeds clears a flag an earlier
  // one set: the field describes the read behind the tree THIS step pushed, not a high-water
  // mark of every read the step has ever made.
  delete step.validationConfigUnreadable
  if (!frame) return {}
  try {
    const resolved = await deps.resolveValidationChecks?.(workspaceId, frame.id)
    if (!resolved) return {}
    // ONE read yields TWO context fields. The DEPENDENCY PREPOPULATION install shares the frame's
    // config row, but the container executor gates the two differently: the checks travel only on
    // a PR-opening dispatch, the install on every dispatch that gets a checkout. So it is lifted
    // to its own top-level field here rather than left nested, which would tie prepopulation to
    // the pre-PR gate and silently exclude every explore kind. Both ride the same spread-ready
    // fragment so the fold at the `buildContext` call site stays branch-free.
    return {
      validationChecks: resolved,
      ...(resolved.dependencyInstall ? { dependencyInstall: resolved.dependencyInstall } : {}),
    }
  } catch (error) {
    // A config-store read failure must never wedge a run: a mothership node whose server doesn't
    // reflect this repository, or a transient store outage, would otherwise fail EVERY coding
    // dispatch. Degrade to "no checks", which is exactly the unconfigured behaviour, so the PR
    // opens as it did before the feature existed rather than the whole build stopping.
    //
    // But degrade LOUDLY. The degradation is indistinguishable from a service that configured
    // nothing, so it is stated twice: once to the operator here, and once on the step, which is
    // what carries it onto the PR verification report for the human reviewing the pull request
    // this dispatch opens. Neither is optional: an unwired logger would leave a service whose
    // checks silently stopped running with no trace anywhere.
    step.validationConfigUnreadable = true
    deps.logger?.warn(
      'Validation config read failed; dispatching with no checks and no dependency install',
      { workspaceId, frameId: frame.id, stepAgentKind: step.agentKind, ...describeError(error) },
    )
    return {}
  }
}

/**
 * The BUGFIX REPRODUCTION PROOF spec for this dispatch, as a spreadable `{ reproduction? }`.
 *
 * Unlike its sibling above this is PURE and reads nothing: the declaration is already on the run's
 * own steps (the prior `repro-test` step's structured outcome), so it costs no round-trip and
 * needs no degrade-on-throw swallow. Reuses the service's pre-PR validation repair budget when one
 * is configured, so an operator meets ONE attempt-budget concept rather than two: a service that
 * set that budget to fail fast gets a matching number of proof rounds, which is the intended
 * coupling, not a leak. Absent ⇒ no context field ⇒ no job-body field ⇒ the harness's existing
 * path.
 */
export function reproductionFor(
  agentKind: string,
  agentConfig: Block['agentConfig'],
  instance: ExecutionInstance,
  validationChecks: { validationChecks?: ResolvedValidationChecks },
): { reproduction?: ResolvedReproduction } {
  const reproduction = resolveReproductionSpec({
    agentKind,
    agentConfig,
    steps: instance.steps,
    currentStep: instance.currentStep,
    maxAttempts: validationChecks.validationChecks?.maxAttempts,
  })
  return reproduction ? { reproduction } : {}
}
