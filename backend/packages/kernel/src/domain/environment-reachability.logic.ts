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
import { environmentUnreachableReasonSchema } from '@cat-factory/contracts'
import type { RouteProbeOutcome, RouteProbeRequest } from '../ports/route-probe.js'
import { isBridgeableAddress } from '../shared/environment-host-bridge.logic.js'

/** How much of a probe's own error message is kept on the attempt it explains. */
const MAX_PROBE_DETAIL_CHARS = 200

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

/**
 * One target a proof will try, in the order the proof will try it.
 *
 * A discriminated union rather than a dial target with a "skip me" flag, because the refused
 * member carries NO {@link RouteProbeRequest}: an address the platform will not dial must be
 * structurally undialable by whoever iterates this list, not merely marked. Handing out a request
 * beside a boolean is how the next caller opens the socket anyway.
 */
export type RouteProbeTarget =
  /** Open a socket to this. `address` is null when the target dials the URL's own name. */
  | { kind: 'dial'; request: RouteProbeRequest; address: string | null; label: string }
  /** RECORD this and dial nothing: a stated address {@link isBridgeableAddress} refuses. */
  | { kind: 'refused'; address: string; label: string; reason: EnvironmentUnreachableReason }

/**
 * The targets a proof tries for one environment, in order: the URL's own name first, then each
 * stated address in the PROVIDER'S preference order.
 *
 * The name goes first because it is the answer that needs no bridge, and a deployment where it
 * works must not start paying for `--add-host` entries and the warm-pool evictions they cost. The
 * addresses keep the provider's order because the provider is the only thing that knows which of
 * its balancers is the one it wants used; the platform decides only which one CARRIED.
 *
 * **A stated address is dialled only if a bridge could NAME it.** The rule is
 * `isBridgeableAddress`, and applying it HERE rather than only at bridge-build time is the whole
 * safety property of the probe: `addresses` is provider-authored data, so without it the
 * orchestrator opens sockets wherever a manifest says and records the results on a row a workspace
 * can read back, which is a liveness oracle against the deployment's own private network. The
 * refusal costs nothing real either, because an address no bridge may name is an address no
 * container could be pointed at, so proving it would prove something unusable. Refused addresses
 * are RECORDED (`kind: 'refused'`) rather than dropped: a shortened list nobody is told about is
 * how a provider's bad address becomes an unexplained `name_unresolved`.
 *
 * Empty when there is no host or port to dial, which the caller reads as `no_candidate`: an
 * environment with no URL was never going to be reached, and that is a different fact from one
 * that was tried and failed.
 */
export function planRouteProbes(
  host: string | null | undefined,
  port: number | null | undefined,
  candidates: readonly EnvironmentAddress[] = [],
  timeoutMs: number = ROUTE_PROBE_TIMEOUT_MS,
): RouteProbeTarget[] {
  if (!host || !port) return []
  const targets: RouteProbeTarget[] = [
    { kind: 'dial', request: { host, port, timeoutMs }, address: null, label: `${host}:${port}` },
  ]
  const seen = new Set<string>()
  let dialable = 0
  let refused = 0
  for (const candidate of candidates) {
    const address = candidate.address.trim()
    if (!address || seen.has(address)) continue
    seen.add(address)
    const label = `${host}@${address}:${port}`
    // Bounded separately, and by `continue` rather than `break`, so a manifest listing four
    // refused addresses ahead of a good one still gets the good one dialled. A refusal costs no
    // I/O; the dial budget is what the deployer's settle path is actually waiting on.
    if (!isBridgeableAddress(address)) {
      if (refused < MAX_PROBED_ADDRESSES) {
        refused += 1
        targets.push({ kind: 'refused', address, label, reason: 'address_refused' })
      }
      continue
    }
    if (dialable >= MAX_PROBED_ADDRESSES) continue
    dialable += 1
    targets.push({ kind: 'dial', request: { host, address, port, timeoutMs }, address, label })
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
      // Never reached: `recordRouteAttempt` answers `carried` before asking. Present so the
      // switch stays total against the port's union.
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

/**
 * Record one DIALLED attempt for the proof's log, whether it carried or not.
 *
 * `detail` rides along for the one outcome that names no layer: `probe_failed` says "we could not
 * tell", and the probe's own message is then the only thing that distinguishes a resolver fault
 * from a runtime restriction from a bug here. Capped rather than dropped or passed whole, because
 * it lands in an operator's failure prose and in an agent's prompt.
 */
export function recordRouteAttempt(
  target: Extract<RouteProbeTarget, { kind: 'dial' }>,
  outcome: RouteProbeOutcome,
): EnvironmentRouteAttempt {
  if (outcome.state === 'carried') return { target: target.label, outcome: 'carried' }
  const detail = outcome.state === 'failed' ? outcome.detail.trim() : ''
  return {
    target: target.label,
    outcome: reasonFor(outcome, target.address),
    ...(detail ? { detail: detail.slice(0, MAX_PROBE_DETAIL_CHARS) } : {}),
  }
}

/** Record a target the platform REFUSED to dial, so the omission is on the proof rather than lost. */
export function recordRefusedAttempt(
  target: Extract<RouteProbeTarget, { kind: 'refused' }>,
): EnvironmentRouteAttempt {
  return { target: target.label, outcome: target.reason }
}

/**
 * Whether one attempt's outcome leaves a route the platform never actually RULED OUT.
 *
 * The rule that decides whether a proof is a verdict about the environment or an admission about
 * the platform, and it lives here because two layers read the answer and neither may re-derive it:
 * the deployer fails a frame on the first and must never fail one on the second. `probe_failed`
 * names no layer by construction, so an attempt that produced it establishes nothing; every other
 * outcome does establish something, `address_refused` included, since an address no bridge may
 * name is one no container could have been pointed at either way.
 */
const LEAVES_ROUTE_UNKNOWN: Record<EnvironmentUnreachableReason, boolean> = {
  no_candidate: true,
  name_unresolved: false,
  no_route: false,
  connection_refused: false,
  address_refused: false,
  probe_failed: true,
}

/**
 * Read an attempt's stored outcome as a known reason, or undefined.
 *
 * Derived from the picklist's own options rather than a hand-listed set, so adding a member fails
 * the `Record` above until it has picked a side. An outcome this build does not know (a proof
 * written by a newer one) is treated as leaving the route unknown, which is the disposition that
 * cannot turn an unreadable value into a failed deploy.
 */
function knownReason(outcome: string): EnvironmentUnreachableReason | undefined {
  return (environmentUnreachableReasonSchema.options as readonly string[]).includes(outcome)
    ? (outcome as EnvironmentUnreachableReason)
    : undefined
}

function leavesRouteUnknown(outcome: string): boolean {
  const reason = knownReason(outcome)
  return reason === undefined || LEAVES_ROUTE_UNKNOWN[reason]
}

/**
 * Fold a completed set of attempts into the proof that is stored and narrated.
 *
 * Three outcomes, and which one this returns is the most consequential line in the feature,
 * because only `not_reached` fails a deployer frame:
 *
 *   - **`reached`** as soon as any attempt carried, publishing the target that did.
 *   - **`inconclusive`** when nothing carried AND some attempt left a route unruled-out: a probe
 *     that could not classify its own failure, or nothing to try at all. A workerd connect message
 *     matching none of that facade's markers, or a Node errno outside the mapped five, arrives
 *     here, and reading either as a verdict about the environment is how a diagnostic becomes a
 *     second way for a healthy deploy to die. The reason names the attempt that left it unknown.
 *   - **`not_reached`** only when EVERY attempt established something and none of them carried.
 *     The reported reason is then the FIRST attempt's, which is always the name, so a reader is
 *     told what happened to the address they were given rather than what happened to the last
 *     balancer in someone's preference list. The attempt log carries the rest, in order.
 */
export function reduceRouteProof(
  attempts: readonly EnvironmentRouteAttempt[],
  carriedVia: string | null,
  checkedAt: number,
): EnvironmentRouteProof {
  if (attempts.some((attempt) => attempt.outcome === 'carried'))
    return { state: 'reached', via: carriedVia, reason: null, attempts: [...attempts], checkedAt }
  if (attempts.length === 0) {
    return {
      state: 'inconclusive',
      via: null,
      reason: 'no_candidate' satisfies EnvironmentUnreachableReason,
      attempts: [],
      checkedAt,
    }
  }
  const unknown = attempts.find((attempt) => leavesRouteUnknown(attempt.outcome))
  if (unknown) {
    return {
      state: 'inconclusive',
      via: null,
      reason: unknown.outcome,
      attempts: [...attempts],
      checkedAt,
    }
  }
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
  address_refused:
    'every address its provider stated is one no host bridge may name (loopback, link-local or vendor metadata, or a non-canonical literal), so none could be dialled',
  probe_failed: 'the probe could not complete, so nothing was established either way',
}

/**
 * The operator-facing sentence for an environment nothing could reach, with every target tried.
 *
 * States the LAYER rather than a verdict about the application, because they are different faults
 * with different owners and the whole point of proving the route is to stop reporting one as the
 * other. The attempt list is included verbatim, each attempt carrying its `detail` where it has
 * one: a reader who wants to reproduce the finding needs the exact targets, the reason alone names
 * none of them, and a `probe_failed` with its detail stripped is a sentence saying only that
 * something went wrong somewhere.
 */
export function describeUnreachableEnvironment(
  url: string | null,
  proof: EnvironmentRouteProof,
): string {
  const reason = proof.reason as EnvironmentUnreachableReason | null
  const cause = (reason && UNREACHABLE_CAUSES[reason]) || UNREACHABLE_CAUSES.probe_failed
  const where = url ? `The environment at ${url} is unreachable` : 'The environment is unreachable'
  return `${where}: ${cause}.${describeRouteAttempts(proof)}`
}

/**
 * The operator-facing sentence for a proof that established nothing either way, with every target
 * tried.
 *
 * Its own describer rather than a branch inside {@link describeUnreachableEnvironment}, because
 * every clause differs: this one may not say "unreachable", must not name a layer as the fault,
 * and exists to be readable beside a run that CONTINUED. Nothing settles on it; it is what the
 * deployer logs and what the environment surface shows so an inconclusive proof is visible rather
 * than merely harmless.
 */
export function describeInconclusiveRoute(
  url: string | null,
  proof: EnvironmentRouteProof,
): string {
  const reason = proof.reason as EnvironmentUnreachableReason | null
  const cause = (reason && UNREACHABLE_CAUSES[reason]) || UNREACHABLE_CAUSES.probe_failed
  const where = url ? `The route to the environment at ${url}` : 'The route to the environment'
  return `${where} could not be established either way: ${cause}.${describeRouteAttempts(proof)}`
}

/** ` Tried: <target> (<outcome>: <detail>), ….`, or empty when nothing was tried. */
function describeRouteAttempts(proof: EnvironmentRouteProof): string {
  const tried = proof.attempts
    .map(
      (attempt) =>
        `${attempt.target} (${attempt.outcome}${attempt.detail ? `: ${attempt.detail}` : ''})`,
    )
    .join(', ')
  return tried ? ` Tried: ${tried}.` : ''
}

/**
 * The proof recorded when nothing was wired to open a socket.
 *
 * Its own constructor rather than a `not_reached` with a special reason, because the two are
 * verdicts about different things: `not_reached` is about the environment and fails the frame,
 * `unproved` is about the deployment and must never fail anything. A facade that cannot probe is
 * a facade that behaves exactly as it did before this existed.
 *
 * Distinct from `inconclusive` too, which is the probe having RUN and established nothing. Both
 * are admissions rather than verdicts, and the difference is who is told: an inconclusive proof is
 * narrated to the agent that has to interpret a connection failure, an unproved one is withheld
 * from every prompt (`reachabilityNote`) because it is the standing state of the deployment.
 */
export function unprovedRoute(checkedAt: number): EnvironmentRouteProof {
  return { state: 'unproved', via: null, reason: null, attempts: [], checkedAt }
}
