import { TESTER_AGENT_KIND } from './run-evidence.js'
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
// ---------------------------------------------------------------------------

/**
 * The agent kind that PROVISIONS a run's ephemeral environments — the sole provisioner, which
 * is why every consumer below is stated relative to it. The canonical slug also backs
 * integrations' `DEPLOYER_AGENT_KIND` (re-exported there).
 */
export const DEPLOYER_AGENT_KIND = 'deployer'

/**
 * The agent kind that RECLAIMS them again, the deployer's counterpart at the other end of the
 * lifecycle. It tears down by the environment ids the deployer RECORDED on its own step, so it
 * has nothing whatsoever to do without one earlier in the chain.
 */
export const DISPOSER_AGENT_KIND = 'disposer'

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
 * The three ways a step list gets the environment lifecycle wrong. Machine-readable, so the SPA
 * maps each to translated copy and the backend's refusal carries it on `details.reason` rather
 * than making a client string-match the message.
 *
 *  - `consumer_without_deployer` — a tester / acceptance / human-test step with no enabled
 *    `deployer` before it. Nothing provisions what it reads.
 *  - `deployer_without_disposer` — an enabled `deployer` with no enabled `disposer` after it.
 *    The environment it stands up outlives the run, reclaimed (if at all) by the TTL sweep long
 *    after the run settled, which is a backstop and cannot close the run's own teardown proof.
 *  - `disposer_without_deployer` — an enabled `disposer` with no enabled `deployer` before it.
 *    It reclaims by the ids the deployer recorded, so with none it can only report that there
 *    was nothing to reclaim, which is indistinguishable from a clean teardown.
 */
export type PipelineEnvironmentProblemReason =
  | 'consumer_without_deployer'
  | 'deployer_without_disposer'
  | 'disposer_without_deployer'

/** One lifecycle fault, anchored on the step that carries it. */
export interface PipelineEnvironmentProblem {
  reason: PipelineEnvironmentProblemReason
  /** The offending step's index in the pipeline's parallel arrays. */
  index: number
  /** The offending step's agent kind, so a message can name it without a second lookup. */
  agentKind: string
}

/**
 * Every environment-lifecycle fault in a step list, in step order.
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
): PipelineEnvironmentProblem[] {
  const isEnabled = (i: number) => enabled?.[i] !== false
  const problems: PipelineEnvironmentProblem[] = []
  let deployerSeen = false
  for (let i = 0; i < agentKinds.length; i++) {
    const agentKind = agentKinds[i]
    if (agentKind === undefined || !isEnabled(i)) continue
    if (agentKind === DEPLOYER_AGENT_KIND) {
      deployerSeen = true
      const reclaimed = agentKinds.some(
        (kind, j) => j > i && kind === DISPOSER_AGENT_KIND && isEnabled(j),
      )
      if (!reclaimed) problems.push({ reason: 'deployer_without_disposer', index: i, agentKind })
    } else if (agentKind === DISPOSER_AGENT_KIND) {
      if (!deployerSeen) problems.push({ reason: 'disposer_without_deployer', index: i, agentKind })
    } else if (!deployerSeen && ENV_CONSUMER_AGENT_KINDS.includes(agentKind)) {
      problems.push({ reason: 'consumer_without_deployer', index: i, agentKind })
    }
  }
  return problems
}
