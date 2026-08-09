import { ValidationError } from '@cat-factory/kernel'
import {
  DEPLOYER_AGENT_KIND,
  DISPOSER_AGENT_KIND,
  pipelineEnvironmentProblems,
} from '@cat-factory/contracts'
import type { PipelineEnvironmentProblem, StepOptions } from '@cat-factory/contracts'

/**
 * AUTHORING-time validation: the correctness rules a human COMPOSING a pipeline must satisfy,
 * checked when a pipeline is created or edited.
 *
 * Deliberately a layer ABOVE `validatePipelineShape` rather than part of it, and the split is
 * about which door each rule may stand in:
 *
 *  - `validatePipelineShape` states what is BROKEN: a companion reviewing nothing, a skill step
 *    with no skill, an estimate gate with no estimator. A run built from such a chain cannot do
 *    the thing it says it does, so both the save boundary and the RUN door refuse it.
 *  - These rules state what is INCOMPLETE. Each names a real dead end, but a pipeline authored
 *    before the rule existed still executes: a chain with no `disposer` leaves its environment to
 *    the TTL sweep, and one with no `deployer` runs fine against an `infraless` service. Enforcing
 *    them at the run door would therefore refuse runs of already-stored pipelines that work today,
 *    including every workspace's seeded copy of a built-in that predates this rule. So they bind
 *    what is being AUTHORED, and the run door keeps its own service-aware guard
 *    (`RunAdmission.assertDeployerBeforeConsumer`) for a stored chain that would genuinely
 *    dead-end on the service it was started against.
 *
 * The one rule today is the environment lifecycle: provision (`deployer`) → consume (a tester /
 * acceptance / human-test step) → reclaim (`disposer`, or a deployer that DECLARES its environment
 * outlives the run). It is enforced structurally, on the step list alone, because a pipeline is a
 * workspace-level template applied to any block and cannot see which service it will run against.
 * That is workable precisely because the Deployer NO-OPS on a service that stands nothing up, so
 * ONE pipeline covers every provision type instead of the catalog fanning out into a pipeline per
 * infra type.
 *
 * Every fault is reported, not just the first: a draft missing both a Deployer and a Disposer
 * should say so once rather than over two rejected saves.
 */
export function validatePipelineAuthoring(pipeline: {
  agentKinds: string[]
  enabled?: boolean[]
  stepOptions?: (StepOptions | null)[]
}): void {
  const problems = pipelineEnvironmentProblems(
    pipeline.agentKinds,
    pipeline.enabled,
    pipeline.stepOptions,
  )
  if (!problems.length) return
  throw new ValidationError(problems.map(describeEnvironmentProblem).join(' '), {
    // The machine-readable half, so a client reacts to the specific fault rather than
    // string-matching the message. `reason` names the FIRST fault (the one whose fix comes
    // earliest in the chain); `problems` carries them all with the step each one sits on.
    reason: problems[0]!.reason,
    problems,
  })
}

/** The actionable sentence for one lifecycle fault, naming the step it sits on and the fix. */
function describeEnvironmentProblem(problem: PipelineEnvironmentProblem): string {
  switch (problem.reason) {
    case 'consumer_without_deployer':
      return (
        `Step '${problem.agentKind}' runs against a provisioned environment, but no enabled ` +
        `'${DEPLOYER_AGENT_KIND}' step comes before it, so nothing would stand one up. Add a ` +
        `Deployer earlier in the pipeline. It is a no-op on a service that provisions nothing, ` +
        `so one pipeline still covers every kind of service.`
      )
    case 'consumer_after_disposer':
      return (
        `Step '${problem.agentKind}' runs against a provisioned environment, but the enabled ` +
        `'${DISPOSER_AGENT_KIND}' step before it has already reclaimed the one the ` +
        `'${DEPLOYER_AGENT_KIND}' stood up, so there would be nothing left to run against. Move ` +
        `the Disposer after this step, or add another Deployer before it.`
      )
    case 'deployer_without_disposer':
      return (
        `Step '${problem.agentKind}' provisions an ephemeral environment, but no enabled ` +
        `'${DISPOSER_AGENT_KIND}' step comes after it, so nothing in the run would reclaim it. ` +
        `Add a Disposer after the last step that needs the environment, or mark this Deployer as ` +
        `keeping its environment past the run if that is deliberate.`
      )
    case 'disposer_without_deployer':
      return (
        `Step '${problem.agentKind}' reclaims the environments this run provisioned, but nothing ` +
        `is standing by the time it runs: no enabled '${DEPLOYER_AGENT_KIND}' step comes before ` +
        `it, or an earlier Disposer already reclaimed what did. Add a Deployer earlier in the ` +
        `pipeline, or drop this Disposer.`
      )
    case 'retained_deployer_reclaimed':
      return (
        `Step '${problem.agentKind}' is marked as keeping its environment past the run, but an ` +
        `enabled '${DISPOSER_AGENT_KIND}' step after it reclaims exactly what this step ` +
        `provisioned, so the environment would be torn down anyway. Drop the Disposer, or clear ` +
        `the Deployer's keep-environment setting.`
      )
  }
}
