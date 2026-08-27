import type { AgentRunContext } from '@cat-factory/kernel'
import { runsAgainstEphemeralEnvironment } from '@cat-factory/agents'
import type { AdvanceResult } from './advance.js'

// ---------------------------------------------------------------------------
// The last guard between "this run provisioned no reachable environment" and an agent being told
// to test one.
//
// The prompt for a step in ephemeral-environment mode says "test against the environment
// described above" and then prints `URL: (pending)`. Those two are contradictory, and the same
// prompt's bail-out instruction ("if you cannot run a meaningful test at all, set abort") is not
// a bound: the run this guard was written for reasoned "rather than abort with nothing, I
// exercised the change against the actual deployment artifacts locally", reconstructed the
// Dockerfile's stages by hand, tested THAT, and returned `greenlight: true` with the environment
// recorded as skipped. On a task whose entire brief was "stand up the API", the single unverified
// thing was the deliverable.
//
// That rationalization is predictable and will recur, which is the argument for refusing in the
// engine rather than for a sterner prompt: a step told to test a URL it was not given has no good
// move. The deployer's readiness wait is what normally makes this unreachable; this covers what a
// wait cannot (an environment that expired mid-run, a chain with no `deployer` in it at all).
// ---------------------------------------------------------------------------

/**
 * The refusal for an env-consuming step with no reachable environment, or null when there is
 * nothing to refuse.
 *
 * Keyed off the SAME predicate the prompt branches on ({@link runsAgainstEphemeralEnvironment}),
 * so the guard and the instructions cannot disagree about which steps are in ephemeral mode: one
 * keyed off a near-miss condition would either refuse a step the prompt was going to let stand up
 * its own infra, or let through the exact case it exists to catch.
 *
 * The `environment` failure kind (not `preflight`) because that is where the fix is: the
 * provisioning that did not finish, or the environment that went away.
 */
export function environmentDispatchRefusal(context: AgentRunContext): AdvanceResult | null {
  if (!runsAgainstEphemeralEnvironment(context)) return null
  if (context.environment?.url) return null
  const status = context.environment?.status
  // An environment that exists but is not reachable and one that was never provisioned are
  // different faults with different fixes — the provider in the first case, the CHAIN (a tester
  // with no `deployer` ahead of it) in the second — so they carry different codes rather than one
  // "no environment" catch-all.
  if (!status) {
    return {
      kind: 'job_failed',
      error: 'No ephemeral environment was provisioned for this service.',
      failureKind: 'environment',
      detail:
        'This step runs against an ephemeral environment, and this run provisioned none. A ' +
        'service declaring kubernetes/custom provisioning needs a `deployer` step ahead of its tester.',
      reason: 'environment_missing',
    }
  }
  return {
    kind: 'job_failed',
    error: 'The ephemeral environment for this step is not reachable.',
    failureKind: 'environment',
    detail: `The service's environment is '${status}' and carries no URL, so there is no address to test against.`,
    reason: 'environment_not_ready',
  }
}
