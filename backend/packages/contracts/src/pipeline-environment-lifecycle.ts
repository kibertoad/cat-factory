import { DEPLOYER_AGENT_KIND, DISPOSER_AGENT_KIND, TESTER_AGENT_KIND } from './run-evidence.js'
import { UI_TESTER_AGENT_KIND } from './visual-pipeline.js'

// ---------------------------------------------------------------------------
// The ENVIRONMENT LIFECYCLE a pipeline's steps have to spell out: provision (`deployer`) →
// consume (a tester / acceptance / human-test step) → reclaim (`disposer`).
//
// Stated once here, in the package both the backend and the SPA compile against, because three
// surfaces have to agree about it and each of them answers a different half of the same question:
//
//  - the pipeline BUILDER, which warns while a draft is being composed;
//  - the SAVE boundary, which refuses a draft that would run into one of these dead ends;
//  - the palette, which has to offer the Deployer and the Disposer wherever a tester is offered.
//
// The rule is deliberately structural: it reads the step list and nothing else. Whether a given
// SERVICE actually needs an environment is workspace state a pipeline cannot see (a pipeline is a
// workspace-level template applied to any block), and the answer the platform settled on is that
// the Deployer is present unconditionally and NO-OPS on a service that stands nothing up
// (`infraless` / `docker-compose` with no handler). One pipeline covers every provision type;
// there is no pipeline-per-infra-type fan-out, and that is what makes a purely structural rule
// the right one to enforce.
//
// RECLAIM IS THE DEFAULT, NOT THE ONLY LEGAL END. An environment that deliberately outlives its
// run is a real shape (a preview a reviewer pokes at after the PR is open), so the reclaim leg is
// satisfied EITHER by a `disposer` or by the deployer step DECLARING the retention
// (`StepOptions.retainEnvironment`). What the rule refuses is the third case, silence: a chain
// that neither reclaims nor says it means not to, which is indistinguishable from an author who
// forgot. The declaration is not a validation bypass — it is the fact the PR verification report
// needs to render the teardown leg as `retained` rather than as a `pending` reclaim that is never
// coming (`prReport.environments.ts`).
// ---------------------------------------------------------------------------

/**
 * The two slugs this module is stated relative to: the kind that PROVISIONS a run's ephemeral
 * environments (the sole provisioner) and the kind that RECLAIMS them again at the other end of
 * the lifecycle.
 *
 * DEFINED in `run-evidence.ts` and re-exported here, which is the opposite direction from the
 * rest of this package's slugs and is a load-bearing detail rather than a tidiness one. The
 * evidence reductions read the same two steps (which one recorded the per-frame outcomes, which
 * one recorded the reclaims), and that module has to stay a LEAF: it already supplies this one's
 * `TESTER_AGENT_KIND`, so a second edge back would close an import cycle whose only symptom is a
 * TDZ `ReferenceError` at module load, in the spec generator rather than in a test.
 * `DEPLOYER_AGENT_KIND` also backs integrations' re-export of the same name.
 */
export { DEPLOYER_AGENT_KIND, DISPOSER_AGENT_KIND } from './run-evidence.js'

/**
 * The agent kind of the human-testing gate: it parks for a person to validate the change in the
 * live URL, so it reads the environment rather than standing one up. The canonical slug also
 * backs orchestration's `HUMAN_TEST_AGENT_KIND` (re-exported there).
 */
export const HUMAN_TEST_AGENT_KIND = 'human-test'

/**
 * The agent kind of the acceptance-test author. The canonical slug also backs agents'
 * `ACCEPTANCE_AGENT_KINDS` (which is built from it).
 */
export const ACCEPTANCE_AGENT_KIND = 'playwright'

/**
 * The steps that CONSUME a provisioned environment to run against: the API/UI testers, the
 * acceptance runner, and the human-test gate. Each reads the environment's coordinates and none
 * of them provisions, so a chain reaching one with no `deployer` in front of it dead-ends inside
 * the consumer on any service that stands an environment up.
 */
export const ENV_CONSUMER_AGENT_KINDS: readonly string[] = [
  TESTER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
  ACCEPTANCE_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
]

/**
 * The ways a step list gets the environment lifecycle wrong. Machine-readable, so the SPA maps
 * each to translated copy and the backend's refusal carries it on `details.reason` rather than
 * making a client string-match the message.
 *
 *  - `consumer_without_deployer`: a tester / acceptance / human-test step with no enabled
 *    `deployer` before it. Nothing provisions what it reads.
 *  - `consumer_after_disposer`: a consumer that IS preceded by a deployer, but also by the
 *    `disposer` that reclaimed it, with no re-provision in between. The environment is gone by
 *    the time the step runs, so it dead-ends exactly as an unprovisioned one does; the two are
 *    separate reasons because the fixes are opposite (add a Deployer vs move the Disposer down).
 *  - `deployer_without_disposer`: an enabled `deployer` with no enabled `disposer` after it and
 *    no {@link StepOptions.retainEnvironment} declaration. The environment it stands up outlives
 *    the run, reclaimed (if at all) by the TTL sweep long after the run settled, which is a
 *    backstop and cannot close the run's own teardown proof.
 *  - `disposer_without_deployer`: an enabled `disposer` with no LIVE environment in front of it,
 *    because no enabled `deployer` precedes it or an earlier disposer already reclaimed what did.
 *    It reclaims by the ids the deployer recorded, so with none it can only report that there was
 *    nothing to reclaim, which is indistinguishable from a clean teardown.
 *  - `retained_deployer_reclaimed`: a `deployer` that declares `retainEnvironment` with an enabled
 *    `disposer` after it, which reclaims by the ids that deployer recorded. The declaration and
 *    the chain say opposite things and the chain is the one that runs, so an author who ticked
 *    "keep this environment" would otherwise watch it disappear with nothing naming the reason.
 */
export type PipelineEnvironmentProblemReason =
  | 'consumer_without_deployer'
  | 'consumer_after_disposer'
  | 'deployer_without_disposer'
  | 'disposer_without_deployer'
  | 'retained_deployer_reclaimed'

/** One lifecycle fault, anchored on the step that carries it. */
export interface PipelineEnvironmentProblem {
  reason: PipelineEnvironmentProblemReason
  /** The offending step's index in the pipeline's parallel arrays. */
  index: number
  /** The offending step's agent kind, so a message can name it without a second lookup. */
  agentKind: string
}

/**
 * The only per-step option this rule reads, structurally typed so the rule stays at the bottom of
 * the package's import graph. `StepOptions` (entities) is the shape both real callers pass.
 */
export interface EnvironmentStepOptions {
  retainEnvironment?: boolean | undefined
}

/**
 * Every environment-lifecycle fault in a step list, in step order.
 *
 * Walked as a STATE MACHINE over the enabled steps rather than as a set of presence checks,
 * because every one of these faults is about ORDER and half of them are invisible to a scan that
 * only asks whether a kind appears somewhere. The state is whether an environment is standing at
 * this point in the chain: a `deployer` raises it, a `disposer` drops it, and a consumer is
 * judged against what is standing WHEN IT RUNS. That is what separates a consumer with nothing
 * yet provisioned from one whose environment has already been reclaimed, and it is what lets a
 * chain that provisions twice (`deployer → tester → disposer → deployer → tester → disposer`)
 * read as two clean lifecycles instead of a pile of contradictions.
 *
 * Evaluated over the ENABLED subset, like every other structural pipeline rule: a run is built
 * from the enabled steps alone, so a disabled `deployer` provisions nothing and a disabled
 * consumer needs nothing. That also means "disable the Deployer but leave the Tester on" is
 * caught, which is the shape a half-edited draft most often reaches.
 *
 * Returns every fault rather than the first, so the builder can show a draft's whole remaining
 * work at once instead of one refusal per save.
 */
export function pipelineEnvironmentProblems(
  agentKinds: readonly string[],
  enabled?: readonly (boolean | undefined)[],
  stepOptions?: readonly (EnvironmentStepOptions | null | undefined)[],
): PipelineEnvironmentProblem[] {
  const isEnabled = (i: number) => enabled?.[i] !== false
  const problems: PipelineEnvironmentProblem[] = []
  // Whether an environment is standing at this point in the chain. `reclaimed` is deliberately
  // distinct from `none`: both mean a consumer here has nothing to run against, and they need
  // opposite fixes.
  let environment: 'none' | 'live' | 'reclaimed' = 'none'
  for (let i = 0; i < agentKinds.length; i++) {
    const agentKind = agentKinds[i]
    if (agentKind === undefined || !isEnabled(i)) continue
    if (agentKind === DEPLOYER_AGENT_KIND) {
      environment = 'live'
      // The disposer reclaims by the ids the deployer recorded, so ANY enabled disposer after
      // this one takes this environment down: that is both what satisfies the reclaim
      // requirement and what contradicts a retain declaration.
      const reclaimed = agentKinds.some(
        (kind, j) => j > i && kind === DISPOSER_AGENT_KIND && isEnabled(j),
      )
      if (stepOptions?.[i]?.retainEnvironment === true) {
        if (reclaimed) {
          problems.push({ reason: 'retained_deployer_reclaimed', index: i, agentKind })
        }
      } else if (!reclaimed) {
        problems.push({ reason: 'deployer_without_disposer', index: i, agentKind })
      }
    } else if (agentKind === DISPOSER_AGENT_KIND) {
      if (environment !== 'live') {
        problems.push({ reason: 'disposer_without_deployer', index: i, agentKind })
      }
      environment = 'reclaimed'
    } else if (environment !== 'live' && ENV_CONSUMER_AGENT_KINDS.includes(agentKind)) {
      problems.push({
        reason:
          environment === 'reclaimed' ? 'consumer_after_disposer' : 'consumer_without_deployer',
        index: i,
        agentKind,
      })
    }
  }
  return problems
}

/**
 * The subset of {@link PipelineEnvironmentProblemReason} that names a step which would DEAD-END
 * for want of a live environment, as opposed to one that leaves the lifecycle untidy.
 *
 * Exported because the two halves are enforced at different doors and only these cross both: the
 * save boundary refuses the whole set on what is being AUTHORED, while the run door refuses a
 * STORED chain (see `RunAdmission`) and may only refuse what would genuinely fail on the service
 * the run was started against. A pipeline stored before this rule existed still runs; one whose
 * tester has no environment to read does not.
 */
export const ENV_CONSUMER_STARVATION_REASONS = [
  'consumer_without_deployer',
  'consumer_after_disposer',
] as const satisfies readonly PipelineEnvironmentProblemReason[]

/**
 * The narrow union of {@link ENV_CONSUMER_STARVATION_REASONS}, so a `Record` keyed by it stays
 * total over exactly those two rather than over every reason the save boundary also refuses.
 */
export type EnvConsumerStarvationReason = (typeof ENV_CONSUMER_STARVATION_REASONS)[number]
