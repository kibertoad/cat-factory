// Proving that a `ready` environment can be reached: what to try, in what order, and what the
// answers add up to.
//
// The rule lives here rather than in the provisioning service because two layers act on the
// result and neither may re-derive it: the DEPLOYER settles a frame on the verdict, and the
// container transports build a host bridge out of the address that carried. A second derivation
// is how the platform would come to record a bridge as applied against an address nothing ever
// reached, which is strictly worse evidence than no bridge at all.
//
// Deliberately not a gate. `docs/initiatives/deployment-failure-remediation.md` withdrew a
// `deploy-health` gate that would have probed the environment handle, on the grounds that the
// deployer owns provisioning through to a terminal verdict, and this is that verdict getting one
// more fact behind it.

import type {
  EnvironmentAddress,
  EnvironmentRouteAttempt,
  EnvironmentRouteProof,
  EnvironmentUnreachableReason,
} from '@cat-factory/contracts'
import type { RouteProbeOutcome, RouteProbeRequest } from '../ports/route-probe.js'

/** How long one target gets before it counts as a route that does not carry. */
export const ROUTE_PROBE_TIMEOUT_MS = 4000

/**
 * How many stated addresses a proof will try, on top of the name itself.
 *
 * Bounded because the list is provider-supplied and the proof runs inside the deployer's settle
 * path: an unbounded list is an unbounded stall on a run that is otherwise ready to proceed. Four
 * covers the shape this exists for (an internal and a public balancer per environment, with room
 * for a second availability zone) and the consumer measured live balancers answering in 34ms to
 * 162ms, so the ceiling is well under a second of ordinary cost.
 */
export const MAX_PROBED_ADDRESSES = 4

/** One target a proof will try, in the order the proof will try it. */
export interface RouteProbeTarget {
  request: RouteProbeRequest
  /** The stated address this target dials, or null when it dials the name. */
  address: string | null
  /** How the attempt is recorded: `host:port`, or `host@address:port`. */
  label: string
}

/**
 * The targets a proof tries for one environment, in order: the URL's own name first, then each
 * stated address in the PROVIDER'S preference order.
 *
 * The name goes first because it is the answer that needs no bridge, and a deployment where it
 * works must not start paying for `--add-host` entries and the warm-pool evictions they cost. The
 * addresses keep the provider's order because the provider is the only thing that knows which of
 * its balancers is the one it wants used; the platform decides only which one CARRIED.
 *
 * Empty when there is no host to probe, which the caller reads as `no_candidate`: an environment
 * with no URL was never going to be reached, and that is a different fact from one that was tried
 * and failed.
 */
export function planRouteProbes(
  host: string | null | undefined,
  port: number | null | undefined,
  candidates: readonly EnvironmentAddress[] = [],
  timeoutMs: number = ROUTE_PROBE_TIMEOUT_MS,
): RouteProbeTarget[] {
  if (!host || !port) return []
  const targets: RouteProbeTarget[] = [
    { request: { host, port, timeoutMs }, address: null, label: `${host}:${port}` },
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const address = candidate.address.trim()
    if (!address || seen.has(address)) continue
    seen.add(address)
    if (targets.length > MAX_PROBED_ADDRESSES) break
    targets.push({
      request: { host, address, port, timeoutMs },
      address,
      label: `${host}@${address}:${port}`,
    })
  }
  return targets
}

/**
 * The user-facing reason one probe outcome states, for the target it was tried against.
 *
 * A NAME that does not resolve and an ADDRESS that does not resolve are not the same event, and
 * only the first can happen: an address is dialled, never looked up. A resolver answering
 * `unresolved` for a literal is a probe malfunction, so it is reported as `probe_failed` rather
 * than as a claim about DNS that would send a reader to the wrong zone.
 */
function reasonFor(
  outcome: RouteProbeOutcome,
  address: string | null,
): EnvironmentUnreachableReason {
  switch (outcome.state) {
    case 'carried':
      // Never reached: the caller stops at the first `carried`. Present so the switch stays total.
      return 'probe_failed'
    case 'unresolved':
      return address === null ? 'name_unresolved' : 'probe_failed'
    case 'no_route':
      return 'no_route'
    case 'refused':
      return 'connection_refused'
    case 'failed':
      return 'probe_failed'
  }
}

/** Record one attempt for the proof's log, whether it carried or not. */
export function recordRouteAttempt(
  target: RouteProbeTarget,
  outcome: RouteProbeOutcome,
): EnvironmentRouteAttempt {
  return {
    target: target.label,
    outcome: outcome.state === 'carried' ? 'carried' : reasonFor(outcome, target.address),
  }
}

/**
 * Fold a completed set of attempts into the proof that is stored and narrated.
 *
 * The reported reason is the FIRST attempt's, not the last, and that is deliberate: the first
 * attempt is always the name, so a reader is told what happened to the address they were given
 * rather than what happened to the last balancer in someone's preference list. The attempt log
 * carries the rest, in order, so nothing is lost by choosing.
 */
export function reduceRouteProof(
  attempts: readonly EnvironmentRouteAttempt[],
  carriedVia: string | null,
  checkedAt: number,
): EnvironmentRouteProof {
  if (attempts.length === 0) {
    return {
      state: 'not_reached',
      via: null,
      reason: 'no_candidate' satisfies EnvironmentUnreachableReason,
      attempts: [],
      checkedAt,
    }
  }
  const carried = attempts.some((attempt) => attempt.outcome === 'carried')
  if (carried)
    return { state: 'reached', via: carriedVia, reason: null, attempts: [...attempts], checkedAt }
  return {
    state: 'not_reached',
    via: null,
    reason: attempts[0]?.outcome ?? 'probe_failed',
    attempts: [...attempts],
    checkedAt,
  }
}

/** What each unreachable reason means for whoever has to fix it, in one clause. */
const UNREACHABLE_CAUSES: Record<EnvironmentUnreachableReason, string> = {
  no_candidate: 'the environment carries no address to try, so nothing could be dialled',
  name_unresolved:
    'its hostname resolves nowhere from this deployment, and no address the provider stated for it carried either',
  no_route: 'nothing answered within the probe window, so no route reaches it',
  connection_refused: 'the route reaches it and nothing is listening on that port',
  probe_failed: 'the probe could not complete, so nothing was established either way',
}

/**
 * The operator-facing sentence for an environment nothing could reach, with every target tried.
 *
 * States the LAYER rather than a verdict about the application, because they are different faults
 * with different owners and the whole point of proving the route is to stop reporting one as the
 * other. The attempt list is included verbatim: a reader who wants to reproduce the finding needs
 * the exact targets, and the reason alone names none of them.
 */
export function describeUnreachableEnvironment(
  url: string | null,
  proof: EnvironmentRouteProof,
): string {
  const reason = proof.reason as EnvironmentUnreachableReason | null
  const cause = (reason && UNREACHABLE_CAUSES[reason]) || UNREACHABLE_CAUSES.probe_failed
  const where = url ? `The environment at ${url} is unreachable` : 'The environment is unreachable'
  const tried = proof.attempts.map((attempt) => `${attempt.target} (${attempt.outcome})`).join(', ')
  return tried ? `${where}: ${cause}. Tried: ${tried}.` : `${where}: ${cause}.`
}

/**
 * The proof recorded when nothing was wired to open a socket.
 *
 * Its own constructor rather than a `not_reached` with a special reason, because the two are
 * verdicts about different things: `not_reached` is about the environment and fails the frame,
 * `unproved` is about the deployment and must never fail anything. A facade that cannot probe is
 * a facade that behaves exactly as it did before this existed.
 */
export function unprovedRoute(checkedAt: number): EnvironmentRouteProof {
  return { state: 'unproved', via: null, reason: null, attempts: [], checkedAt }
}
