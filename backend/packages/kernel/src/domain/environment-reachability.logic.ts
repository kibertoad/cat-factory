// Proving that a `ready` environment can be reached: what to look up, what to try, in what order,
// and what the answers add up to.
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
  EnvironmentRouteCandidate,
  EnvironmentRouteAttempt,
  EnvironmentRouteProof,
  EnvironmentUnreachableReason,
} from '@cat-factory/contracts'
import { environmentUnreachableReasonSchema, statedRouteTarget } from '@cat-factory/contracts'
import type { HostResolveOutcome } from '../ports/host-resolver.js'
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
 * How long one stated NAME gets to resolve before the lookup counts as one the platform could not
 * complete.
 *
 * Much tighter than {@link ROUTE_PROBE_TIMEOUT_MS}, because the two wait on different things: a
 * connect legitimately hangs against a route that does not carry, which is the finding, whereas a
 * resolver that has not answered in two seconds is not about to.
 */
export const HOST_RESOLVE_TIMEOUT_MS = 2000

/**
 * How many stated NAMES a proof will look up.
 *
 * Its own bound rather than a share of {@link MAX_PROBED_ADDRESSES}, because they cap different
 * costs: that one caps sockets opened, this one caps lookups made, and one name can expand into
 * several addresses so neither implies the other. The same four, sized for the same shape (an
 * internal and a public balancer, with room for a second availability zone).
 */
export const MAX_RESOLVED_HOSTS = 4

/**
 * The stated NAMES a proof will resolve, in the provider's order, deduplicated and bounded.
 *
 * Exported because the caller does the I/O and the plan consumes the answers, so both have to
 * agree about exactly which names are in scope. Stated ONCE here and read twice rather than
 * recomputed on each side: two copies of a bound is how a name beyond it comes to be reported as a
 * name nothing could resolve.
 */
export function planHostResolutions(
  candidates: readonly EnvironmentRouteCandidate[] = [],
): string[] {
  const hosts: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const stated = statedRouteTarget(candidate)
    if (stated.kind !== 'host' || seen.has(stated.host)) continue
    seen.add(stated.host)
    hosts.push(stated.host)
    if (hosts.length >= MAX_RESOLVED_HOSTS) break
  }
  return hosts
}

/**
 * One target a proof will try, in the order the proof will try it.
 *
 * A discriminated union rather than a dial target with a "skip me" flag, because the second member
 * carries NO {@link RouteProbeRequest}: a target the platform will not dial must be structurally
 * undialable by whoever iterates this list, not merely marked. Handing out a request beside a
 * boolean is how the next caller opens the socket anyway.
 *
 * ONE undialled member rather than one per cause, because the callers do the same thing with all
 * of them (record the attempt, move on) and the cause they differ by is already the
 * {@link EnvironmentUnreachableReason} each carries.
 */
export type RouteProbeTarget =
  /**
   * Open a socket to this. `address` is null when the target dials the URL's own name, and
   * `statedHost` is set when the address came from RESOLVING a stated name rather than from a
   * stated address, so a proof can publish which candidate carried and not merely which literal.
   */
  | {
      kind: 'dial'
      request: RouteProbeRequest
      address: string | null
      statedHost?: string
      label: string
    }
  /**
   * RECORD this and dial nothing: an address {@link isBridgeableAddress} refuses, a candidate
   * naming no single target, a stated name that resolved nowhere, and a stated name this
   * deployment has nothing to resolve with.
   */
  | { kind: 'undialled'; label: string; reason: EnvironmentUnreachableReason; detail?: string }

/** What {@link planRouteProbes} needs beyond the candidate list itself. */
export interface RouteProbePlan {
  /**
   * What the platform's resolver answered for each name {@link planHostResolutions} named, keyed
   * by that same normalized name.
   *
   * A name IN that plan with no entry here means nothing was wired to resolve it, which is an
   * admission about the deployment and is recorded as one. A name beyond the plan's bound is not
   * in scope and is passed over, exactly as an address beyond the dial bound is.
   */
  resolutions?: ReadonlyMap<string, HostResolveOutcome>
  timeoutMs?: number
}

/**
 * The targets a proof tries for one environment, in order: the URL's own name first, then each
 * stated candidate in the PROVIDER'S preference order, a stated NAME expanded IN PLACE into the
 * addresses it resolved to.
 *
 * The URL's name goes first because it is the answer that needs no bridge, and a deployment where
 * it works must not start paying for `--add-host` entries and the warm-pool evictions they cost.
 * The candidates keep the provider's order because the provider is the only thing that knows which
 * of its balancers is the one it wants used; the platform decides only which one CARRIED. A name is
 * expanded in place rather than having its addresses appended, so that order still means something
 * when a provider states a name and an address side by side.
 *
 * **Every dialled target is an address a bridge could NAME**, whether the provider stated it or the
 * platform resolved it. The rule is `isBridgeableAddress`, and applying it HERE rather than only at
 * bridge-build time is the whole safety property of the probe: candidates are provider-authored
 * data, so without it the orchestrator opens sockets wherever a manifest says and records the
 * results on a row a workspace can read back, which is a liveness oracle against the deployment's
 * own private network. Resolving first and grading each answer is what keeps that property intact
 * for a name: the destination a bridge is built from is still an IP the platform itself proved, and
 * a name answering with something unbridgeable is refused per address.
 *
 * The refusal costs nothing real either, because an address no bridge may name is an address no
 * container could be pointed at, so proving it would prove something unusable. Refused and
 * unresolvable targets are RECORDED (`kind: 'undialled'`) rather than dropped: a shortened list
 * nobody is told about is how a provider's bad candidate becomes an unexplained `name_unresolved`.
 *
 * **Every cap this plan applies reports what it passed over**, in one final `not_attempted`
 * target. Three of them bite (names beyond {@link MAX_RESOLVED_HOSTS}, addresses beyond the dial
 * budget, records beyond the recording budget) and each ends the list early, so without that
 * report a proof over a longer list is a prefix presented as the whole thing. It is not a
 * cosmetic omission: {@link reduceRouteProof} grades `not_reached` only when every attempt
 * established something, and a silently shortened list is how the deployer comes to fail a frame
 * on a verdict about candidates the platform never looked at.
 *
 * Empty when there is no host or port to dial, which the caller reads as `no_candidate`: an
 * environment with no URL was never going to be reached, and that is a different fact from one
 * that was tried and failed.
 */
export function planRouteProbes(
  host: string | null | undefined,
  port: number | null | undefined,
  candidates: readonly EnvironmentRouteCandidate[] = [],
  plan: RouteProbePlan = {},
): RouteProbeTarget[] {
  if (!host || !port) return []
  const timeoutMs = plan.timeoutMs ?? ROUTE_PROBE_TIMEOUT_MS
  const targets: RouteProbeTarget[] = [
    { kind: 'dial', request: { host, port, timeoutMs }, address: null, label: `${host}:${port}` },
  ]
  const inScope = new Set(planHostResolutions(candidates))
  const seen = new Set<string>()
  const budget = { dialable: 0, undialled: 0, passedOver: 0 }
  // Bounded by `return` rather than `break`, so a manifest listing four refused addresses ahead of
  // a good one still gets the good one dialled. Recording costs no I/O; the dial budget is what the
  // deployer's settle path is actually waiting on.
  const record = (label: string, reason: EnvironmentUnreachableReason, detail?: string) => {
    if (budget.undialled >= MAX_PROBED_ADDRESSES) {
      budget.passedOver += 1
      return
    }
    budget.undialled += 1
    targets.push({ kind: 'undialled', label, reason, ...(detail ? { detail } : {}) })
  }
  const dial = (address: string, statedHost?: string) => {
    const label = statedHost
      ? `${host}@${address}:${port} (${statedHost})`
      : `${host}@${address}:${port}`
    if (!isBridgeableAddress(address)) return record(label, 'address_refused')
    if (budget.dialable >= MAX_PROBED_ADDRESSES) {
      budget.passedOver += 1
      return
    }
    budget.dialable += 1
    targets.push({
      kind: 'dial',
      request: { host, address, port, timeoutMs },
      address,
      ...(statedHost ? { statedHost } : {}),
      label,
    })
  }
  for (const candidate of candidates) {
    const stated = statedRouteTarget(candidate)
    if (stated.kind === 'unusable') {
      // No target to name, so the label names the position instead of inventing a value: a
      // candidate stating nothing is still an omission the operator has to be able to see.
      record(`${host}@(no target stated):${port}`, 'address_refused')
      continue
    }
    if (stated.kind === 'address') {
      if (seen.has(`a:${stated.address}`)) continue
      seen.add(`a:${stated.address}`)
      dial(stated.address)
      continue
    }
    if (seen.has(`h:${stated.host}`)) continue
    seen.add(`h:${stated.host}`)
    // Beyond the resolution bound. Counted rather than dropped, because the platform is not about
    // to look this name up: nothing is established about the candidate, and a proof that omits it
    // reads as one taken against everything the provider offered.
    if (!inScope.has(stated.host)) {
      budget.passedOver += 1
      continue
    }
    expandHost(stated.host, plan.resolutions?.get(stated.host), `${host}@${stated.host}:${port}`, {
      record,
      dial,
      seen,
    })
  }
  if (budget.passedOver > 0) targets.push(passedOverTarget(budget.passedOver))
  return targets
}

/**
 * The one target that says the plan above is a PREFIX of what the provider stated.
 *
 * ONE entry naming the count, never one per passed-over candidate: what a reader needs is whether
 * anything was left unlooked-at, and N copies of the same admission would spend the attempt log
 * the real attempts live in (which is itself capped, so the copies would crowd out the evidence).
 *
 * Appended LAST, which keeps two rules intact. `reduceRouteProof` reports the FIRST attempt's
 * reason for a determinate proof, and that must stay the URL's own name; and the dials ahead of it
 * are what the settle path waits on, so a target that opens no socket may not delay them.
 */
function passedOverTarget(count: number): Extract<RouteProbeTarget, { kind: 'undialled' }> {
  return {
    kind: 'undialled',
    label:
      count === 1
        ? '1 further target the provider stated'
        : `${count} further targets the provider stated`,
    reason: 'not_attempted',
    detail:
      `The platform resolves at most ${MAX_RESOLVED_HOSTS} stated names and dials at most ` +
      `${MAX_PROBED_ADDRESSES} addresses per environment, and this environment's provider stated ` +
      'more than that.',
  }
}

/**
 * Turn one stated name's resolution into dialled targets, or into the one attempt that says why
 * there are none.
 *
 * The three failures stay apart because they name different owners, which is the same split the
 * resolver port itself draws: nothing wired to resolve is an admission about the DEPLOYMENT, a name
 * that answered nothing is a fact about the NAME, and a lookup that failed is "we could not tell".
 * Only the middle one establishes anything, and a resolution answering an empty address list is
 * that same middle fact rather than a fourth one.
 */
function expandHost(
  statedHost: string,
  resolution: HostResolveOutcome | undefined,
  label: string,
  sink: {
    record: (label: string, reason: EnvironmentUnreachableReason, detail?: string) => void
    dial: (address: string, statedHost: string) => void
    seen: Set<string>
  },
): void {
  if (!resolution) return sink.record(label, 'resolver_unavailable')
  if (resolution.state === 'failed') return sink.record(label, 'probe_failed', resolution.detail)
  const addresses =
    resolution.state === 'resolved'
      ? resolution.addresses.map((address) => address.trim()).filter(Boolean)
      : []
  if (addresses.length === 0) return sink.record(label, 'name_unresolved')
  for (const address of addresses) {
    // Deduplicated against stated addresses and against the other names, because two balancers in
    // one zone routinely answer with an overlapping set and dialling the same literal twice spends
    // the bound on a target already tried.
    if (sink.seen.has(`a:${address}`)) continue
    sink.seen.add(`a:${address}`)
    sink.dial(address, statedHost)
  }
}

/**
 * The user-facing reason one probe outcome states, for the target it was tried against.
 *
 * A NAME that does not resolve and an ADDRESS that does not resolve are not the same event, and
 * only the first can happen: an address is dialled, never looked up. A resolver answering
 * `unresolved` for a literal is a probe malfunction, so it is reported as `probe_failed` rather
 * than as a claim about DNS that would send a reader to the wrong zone. That holds for an address
 * the platform RESOLVED a stated name into as much as for a stated one: the name's own lookup
 * already happened and was recorded, and this attempt dials a literal.
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

/**
 * Record a target the platform never DIALLED, so the omission is on the proof rather than lost.
 *
 * Carries the same `detail` a dialled attempt does, because one of the causes that lands here says
 * nothing on its own: a lookup that failed rather than answering nothing is `probe_failed`, and
 * without the resolver's own words a reader cannot tell a DNS timeout from a resolver outage from a
 * bug in the adapter.
 */
export function recordUndialledAttempt(
  target: Extract<RouteProbeTarget, { kind: 'undialled' }>,
): EnvironmentRouteAttempt {
  const detail = target.detail?.trim() ?? ''
  return {
    target: target.label,
    outcome: target.reason,
    ...(detail ? { detail: detail.slice(0, MAX_PROBE_DETAIL_CHARS) } : {}),
  }
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
  // A deployment with nothing to resolve a name with has not ruled that candidate out; it has
  // declined to look at it. Grading it as established is how a facade missing a resolver would
  // start failing deploys for environments it never dialled.
  resolver_unavailable: true,
  // The same shape of admission, from the platform's own bounds rather than its wiring: a
  // candidate past the cap was passed over, so it is not ruled out, so the list as a whole cannot
  // add up to "nothing reaches this environment".
  not_attempted: true,
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
 * The target that carried, as {@link reduceRouteProof} publishes it: the address, plus the stated
 * NAME it was resolved from when it came from one.
 *
 * The dial target's own shape, so the caller passes what it already has rather than picking two
 * fields apart. Null for a proof where nothing carried, where `via` is null for the other reason.
 */
export type CarryingTarget = Pick<
  Extract<RouteProbeTarget, { kind: 'dial' }>,
  'address' | 'statedHost'
>

/**
 * Fold a completed set of attempts into the proof that is stored and narrated.
 *
 * Three outcomes, and which one this returns is the most consequential line in the feature,
 * because only `not_reached` fails a deployer frame:
 *
 *   - **`reached`** as soon as any attempt carried, publishing the target that did.
 *   - **`inconclusive`** when nothing carried AND some attempt left a route unruled-out: a probe
 *     that could not classify its own failure, a candidate the plan passed over, or nothing to try
 *     at all. A workerd connect message matching none of that facade's markers, or a Node errno
 *     outside the mapped five, arrives here, and reading either as a verdict about the environment
 *     is how a diagnostic becomes a second way for a healthy deploy to die. The reason names the
 *     attempt that left it unknown.
 *   - **`not_reached`** only when EVERY attempt established something and none of them carried.
 *     The reported reason is then the FIRST attempt's, which is always the name, so a reader is
 *     told what happened to the address they were given rather than what happened to the last
 *     balancer in someone's preference list. The attempt log carries the rest, in order.
 */
export function reduceRouteProof(
  attempts: readonly EnvironmentRouteAttempt[],
  carried: CarryingTarget | null,
  checkedAt: number,
): EnvironmentRouteProof {
  if (attempts.some((attempt) => attempt.outcome === 'carried')) {
    return {
      state: 'reached',
      via: carried?.address ?? null,
      ...(carried?.statedHost ? { viaHost: carried.statedHost } : {}),
      reason: null,
      attempts: [...attempts],
      checkedAt,
    }
  }
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
    'every target its provider stated is one no host bridge may name (loopback, link-local or vendor metadata, or a non-canonical literal, or a candidate naming nothing at all), so none could be dialled',
  resolver_unavailable:
    'its provider identified the environment by NAME and this deployment has nothing wired to turn a name into an address, so nothing was established either way',
  not_attempted:
    'its provider stated more targets than the platform will look up and dial for one environment, so at least one of them was never tried and nothing was established either way',
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

/**
 * `<target> (<outcome>: <detail>), …` for every target a proof tried, or the empty string when it
 * tried none.
 *
 * Exported because THREE surfaces render this same list from the same field, and they had drifted
 * into three copies of the template: the two operator sentences below, the investigation's
 * timeline entry, and the investigation prompt's own route section. A change to the attempt shape
 * that has to be found in three packages is a change that gets made in two, which is how one of
 * them came to ship the detail unscrubbed while its neighbour scrubbed it.
 *
 * Renders whatever it is handed. Redaction and capping belong to whoever owns the BOUNDARY the
 * string is crossing (the diagnostics gatherer does both for the prompt and the telemetry store),
 * because an operator reading a failed deploy and a model reading a prompt are owed different
 * amounts of the probe's own words.
 */
export function describeRouteTargets(attempts: readonly EnvironmentRouteAttempt[]): string {
  return attempts
    .map(
      (attempt) =>
        `${attempt.target} (${attempt.outcome}${attempt.detail ? `: ${attempt.detail}` : ''})`,
    )
    .join(', ')
}

/** ` Tried: <target> (<outcome>: <detail>), ….`, or empty when nothing was tried. */
function describeRouteAttempts(proof: EnvironmentRouteProof): string {
  const tried = describeRouteTargets(proof.attempts)
  return tried ? ` Tried: ${tried}.` : ''
}

/**
 * The cause an unreachable environment's own route evidence SETTLES, or null when it settles none.
 *
 * The platform computing what it can compute, so a reader is not left to rank a determinate cause
 * against an inferred one. Both members here name an owner and a concrete fix, and both were
 * SUBORDINATED to a wrong headline in the failure that filed this: the investigation found "no
 * balancer or address field was captured at all" and filed it as one bullet under a verdict
 * blaming a platform readiness gate that had in fact worked, sending a human to change three
 * behaviours that were already correct.
 *
 * Deliberately narrow. It answers only where NOTHING was available to dial, which is a fact about
 * the platform's own inputs rather than a judgement about the environment: whether the workload is
 * healthy, whether the provider is lying and whether anything is worth retrying all stay the
 * model's to settle. `reached` and `inconclusive` therefore settle nothing here, the second
 * because it is an admission about the platform and naming it a cause is how "we could not tell"
 * comes to read as a verdict.
 */
export function determinateRouteCause(
  candidates: readonly EnvironmentRouteCandidate[],
  proof: EnvironmentRouteProof | null,
): string | null {
  if (!proof) return null
  // `no_candidate` arrives as `inconclusive` from {@link reduceRouteProof} (nothing was tried, so
  // nothing was established) and is checked ahead of the state for exactly that reason: it is the
  // one reason whose cause is determinate WITHOUT a verdict about the environment, because the
  // environment published no host and port to dial in the first place.
  if (proof.reason === ('no_candidate' satisfies EnvironmentUnreachableReason)) {
    if (candidates.length === 0) {
      return (
        'This environment carries no address to dial at all: no URL with a host and port, and no ' +
        'address or name stated for one. Nothing was tried because there was nothing to try, so ' +
        'this is a fact about what the provider published, never a verdict about the environment. ' +
        'Whoever maps this provider onto a URL (and onto stated addresses or balancer names, if ' +
        'the URL is not resolvable from this deployment) owns the fix.'
      )
    }
    // The SAME reason, a different fact, and telling a reader the provider stated no addresses
    // when it stated several is the misdirection this whole function exists to prevent. A stated
    // address is dialled on the port the URL names (`planRouteProbes` needs a host AND a port
    // before it will plan anything), so an environment with addresses and no parseable URL had
    // nothing to dial them ON, and the fix is one field over from where the empty-list wording
    // would send someone.
    const count = candidates.length === 1 ? '1 candidate' : `${candidates.length} candidates`
    return (
      `This environment published no URL with a host and port, so the ${count} its provider DID ` +
      'state could not be dialled either: a stated address (or an address a stated name resolves ' +
      'to) is tried on the port the URL names, and there was none. Nothing was tried because ' +
      'there was nothing to try it on, so this is a fact about what the provider published, never ' +
      "a verdict about the environment. Whoever maps this provider onto the environment's URL " +
      'owns the fix; the stated candidates are not the gap here.'
    )
  }
  if (proof.state !== 'not_reached' || candidates.length > 0) return null
  return (
    "The only target that ever existed was the environment's own name, because the provider " +
    'stated no addresses and no balancer names for it. Nothing else was tried because there was ' +
    'nothing else to try: the empty candidate list means candidates were never STATED, not that ' +
    'stated ones were tried and failed. Whoever maps this provider onto stated addresses or names ' +
    'owns the fix, and this ranks ahead of any fault inferred from the ORDER platform events ' +
    'appear to have happened in.'
  )
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
