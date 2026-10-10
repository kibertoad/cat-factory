// Proving that a provisioned environment can be reached, and keeping the claim and the proof in
// step as the provider re-states one and the platform re-runs the other.
//
// The RULE lives in kernel (`planHostResolutions` / `planRouteProbes` / `reduceRouteProof`), which
// is also where the reasoning is: why the name is tried first, why the provider's order is kept for
// the candidates, which addresses the platform will not dial, how a stated NAME expands into the
// addresses it resolves to, and why an unwired prober records `unproved` rather than a failure.
// What lives here is the sequencing.
//
// Where the URL is turned into coordinates is `@cat-factory/contracts`
// (`deriveEnvironmentCoordinates`), the ONE deriver, shared with the Tester prompt that states
// those same coordinates to an agent. A second parser here would let the platform dial one host
// and tell the agent another.

import { deriveEnvironmentCoordinates, statedRouteTarget } from '@cat-factory/contracts'
import type {
  Clock,
  EnvironmentRouteCandidate,
  EnvironmentReachability,
  EnvironmentRouteAttempt,
  EnvironmentRouteProof,
  EnvironmentUnreachableReason,
  HostResolveOutcome,
  HostResolver,
  RouteProbe,
} from '@cat-factory/kernel'
import {
  getErrorMessage,
  HOST_RESOLVE_TIMEOUT_MS,
  planHostResolutions,
  planRouteProbes,
  recordRouteAttempt,
  recordUndialledAttempt,
  reduceRouteProof,
  unprovedRoute,
} from '@cat-factory/kernel'

/**
 * Resolve every stated NAME the plan is willing to look up, then dial the environment's own name
 * and, in the provider's order, each candidate it stated for that name. Stops at the first target
 * that CARRIES and publishes that one.
 *
 * The dials are sequential rather than raced, deliberately. The provider's order is its own
 * statement about which balancer it wants used (an internal one ahead of a public one, say), and
 * racing would publish whichever answered fastest, which is a different question and one nobody
 * asked. The cost is bounded by `MAX_PROBED_ADDRESSES` times the per-probe timeout, against a
 * misdiagnosis that currently costs a whole tester step.
 *
 * The lookups ahead of them are concurrent, and that is not the same trade. Nothing is CHOSEN by
 * answering first: the answers land in a map the plan reads by name, so the provider's order is
 * expressed entirely by the plan and a resolver race could not disturb it. Serialising them would
 * only add up to `MAX_RESOLVED_HOSTS` timeouts to a settle path that is already waiting on dials.
 *
 * With no prober wired the result is `unproved`, never a failure: a facade that cannot open a
 * socket behaves exactly as it did before this existed. Resolution is skipped in that case too,
 * because nothing would be dialled with the answers.
 *
 * It is skipped for an environment with NOTHING TO DIAL for the same reason, and that one is
 * asked of kernel rather than re-derived: the plan is empty when the URL names no host and port,
 * no resolution can add a target to an empty plan, and up to `MAX_RESOLVED_HOSTS` lookups would
 * then be paid for answers nobody reads, on the settle path and again on every status poll that
 * re-proves. Asking the pure plan twice is how that stays ONE condition; a copy of it here is how
 * the resolver comes to be paid on exactly the path its answers cannot reach.
 *
 * The lookups stay AHEAD of the first dial, rather than being deferred until the URL's own name
 * has failed. Deferring would save a healthy lookup (tens of milliseconds) in the case where the
 * URL carries, and a deployment that states names is by construction one whose URL does not; the
 * cost would be handing the plan out in two halves, so that the order the provider stated and the
 * platform's own "name first" rule stopped living in one function.
 *
 * A target the plan will not dial is recorded without a socket being opened. That is the one place
 * the two kinds of target must not be conflated, and why the plan makes an undialled one carry no
 * request to dial.
 */
export async function proveEnvironmentRoute(
  url: string | null | undefined,
  candidates: readonly EnvironmentRouteCandidate[],
  deps: { probe?: RouteProbe; resolveHost?: HostResolver; clock: Clock },
): Promise<EnvironmentRouteProof> {
  const now = deps.clock.now()
  if (!deps.probe) return unprovedRoute(now)
  const coords = deriveEnvironmentCoordinates(url)
  if (planRouteProbes(coords?.host, coords?.port, candidates).length === 0) {
    return reduceRouteProof([], null, now)
  }
  const resolutions = await resolveStatedHosts(candidates, deps.resolveHost)
  const targets = planRouteProbes(coords?.host, coords?.port, candidates, { resolutions })
  const attempts: EnvironmentRouteAttempt[] = []
  for (const target of targets) {
    if (target.kind === 'undialled') {
      attempts.push(recordUndialledAttempt(target))
      continue
    }
    const outcome = await deps.probe(target.request)
    attempts.push(recordRouteAttempt(target, outcome))
    if (outcome.state === 'carried') return reduceRouteProof(attempts, target, now)
  }
  return reduceRouteProof(attempts, null, now)
}

/**
 * Look up the names kernel's plan is willing to look up, and hand back what each one answered.
 *
 * An EMPTY map with no resolver wired, rather than one entry saying so per name: the plan already
 * knows which names it asked about, so a missing entry IS "nothing resolved this", and inventing a
 * per-name placeholder here would put the same fact in two shapes.
 *
 * `allSettled`, so a resolver that breaks its own contract costs its OWN name and not the proof.
 * The port says a resolver never rejects and nothing can enforce that: a facade adapter with an
 * unguarded leg, or one a deployment supplies, would otherwise reject `proveEnvironmentRoute`
 * itself, and the status poll's fold is not best-effort, so the whole poll would throw and leave
 * the environment stuck at whatever it last said. A rejection is the same fact as a lookup that
 * `failed` ("we could not tell"), which is the outcome that leaves the candidate unruled-out.
 */
async function resolveStatedHosts(
  candidates: readonly EnvironmentRouteCandidate[],
  resolveHost: HostResolver | undefined,
): Promise<Map<string, HostResolveOutcome>> {
  if (!resolveHost) return new Map()
  const hosts = planHostResolutions(candidates)
  const settled = await Promise.allSettled(
    hosts.map((host) => resolveHost({ host, timeoutMs: HOST_RESOLVE_TIMEOUT_MS })),
  )
  return new Map(
    hosts.map((host, index): [string, HostResolveOutcome] => {
      const result = settled[index]
      if (result?.status === 'fulfilled') return [host, result.value]
      const detail = getErrorMessage(result?.reason) || 'the host resolver rejected'
      return [host, { state: 'failed', detail }]
    }),
  )
}

/**
 * Fold a provider's freshly stated addresses into what is already stored, and decide whether the
 * proof beside them survives.
 *
 * **A provider that says nothing about addresses is not a provider stating none.** `addresses`
 * absent means this response carried no statement (the manifest declares no `addressesPath`, or
 * the call was one whose shape never carries addresses at all, like the no-`status`-template
 * fallback); `[]` means it declared one and the provider answered with nothing. The distinction is
 * the difference between keeping the candidate list and ERASING it, and erasing it is how the
 * feature turns into a hard failure: the balancer list a provider states once on the CREATE
 * response would be wiped by the first readiness poll, leaving the proof to dial only the name it
 * already knows resolves nowhere and the deployer to settle the frame `failed`. Absent keeps what
 * is stored; a statement replaces it. The same rule as everywhere else in this tree: absent is not
 * empty.
 *
 * The proof survives on what it ESTABLISHED, never on the shape of the list it was handed.
 *
 * Order is not part of any finding. A provider stating addresses from a live DNS answer is stating
 * a value whose order it does not control (`getaddrinfo` applies RFC 6724 destination sorting
 * against the local interface set, and recursive resolvers rotate records between answers), so a
 * sequence comparison drops a good proof on a network change, months later, on someone else's
 * machine. The stated ORDER is still kept for the next probe, because it is the provider's current
 * preference about what to try first; it is just not evidence.
 *
 * So the URL has to be unchanged (every finding was about that name), and then:
 *
 *   - a `reached` proof is a finding about ONE target: the candidate `via` came from, or the URL's
 *     own name when `via` is null. It survives while that candidate is still on offer, and for the
 *     name that means nothing further, the URL having already been checked. A provider adding a
 *     fallback candidate is strictly MORE information and cannot invalidate a proof about a target
 *     it did not touch.
 *
 *     Which candidate that is comes off the proof, never off the address: `viaHost` names the
 *     stated NAME the address was resolved from, and for those the NAME is the target. A balancer
 *     the provider still states, that has scaled or gained a zone since the proof, answers with a
 *     different address set, and matching the stored `via` against it would drop a good proof on a
 *     routine event that says nothing about whether the route still carries. An older proof carries
 *     no `viaHost`, which reads as the address case, which is what it was.
 *   - every other proof is a finding about the whole list that was TRIED, so it survives only
 *     while the candidate SET is unchanged. A new candidate is a target nothing ever dialled, and
 *     "nothing reaches this environment" is no longer established once one exists.
 *
 * A dropped proof costs a re-probe, and the status poll takes one (on the terms
 * {@link routeReproveDecision} sets) rather than leaving the row to be re-proved by a deployer
 * settle that will not run again for that frame: a dropped proof and a proof never taken are the
 * same value, so nothing downstream could tell that the feature had stopped working.
 */
export function foldStatedAddresses(
  previous: EnvironmentReachability | null,
  previousUrl: string | null,
  addresses: readonly EnvironmentRouteCandidate[] | null | undefined,
  url: string | null,
): EnvironmentReachability | null {
  const stored = previous?.candidates ?? []
  const candidates = addresses ? [...addresses] : [...stored]
  const proof =
    previousUrl === url ? survivingProof(previous?.proof ?? null, stored, candidates) : null
  // Carried across a drop, and across a MOVED URL, because it is not a claim about either: it
  // says when the platform last looked, which stays true however little the verdict survives.
  // Without it a dropped proof leaves a row that reads as an environment nothing ever dialled.
  const probedAt = lastLookedAt(previous)
  if (candidates.length === 0 && !proof && probedAt === null) return null
  return { candidates, proof, ...(probedAt === null ? {} : { probedAt }) }
}

/**
 * When the platform last looked at reaching this environment, or null when nothing ever has.
 *
 * Falls back to the proof's own date for a value written before `probedAt` existed, and counts an
 * `unproved` proof as a look: what it records is the SETTLE path having run and found no prober
 * wired, which is the fact the poll needs (the settle owns the first look and will not run again
 * for a frame that already settled, so a poll that treats `unproved` as "never looked" is a poll
 * that leaves such an environment unproved forever, even once the facade can open a socket).
 */
export function lastLookedAt(stored: EnvironmentReachability | null): number | null {
  return stored?.probedAt ?? stored?.proof?.checkedAt ?? null
}

/** A stored proof that still says something about the freshly stated candidates, or null. */
function survivingProof(
  proof: EnvironmentRouteProof | null,
  stored: readonly EnvironmentRouteCandidate[],
  candidates: readonly EnvironmentRouteCandidate[],
): EnvironmentRouteProof | null {
  if (!proof) return null
  if (proof.state === 'reached') {
    if (!proof.via) return proof
    const target = proof.viaHost ? `h:${proof.viaHost}` : `a:${proof.via}`
    return candidates.some((entry) => candidateKey(entry) === target) ? proof : null
  }
  return sameCandidateSet(stored, candidates) ? proof : null
}

/**
 * One candidate's identity, as both the PROOF and the plan spell it.
 *
 * Kind-prefixed so a name and an address that happen to read alike are two candidates rather than
 * one, and read through `statedRouteTarget` so the trimming and lower-casing happen once. That
 * boundary is not cosmetic: `planRouteProbes` trims before it dials, so `via` is a trimmed value,
 * and a raw comparison against the stored candidate crossed it. A provider stating `' 10.4.19.22'`
 * proved `'10.4.19.22'`, matched neither its own candidate nor itself, and paid a fresh probe on
 * every single poll for a proof it already had.
 */
function candidateKey(entry: EnvironmentRouteCandidate): string {
  const stated = statedRouteTarget(entry)
  if (stated.kind === 'address') return `a:${stated.address}`
  if (stated.kind === 'host') return `h:${stated.host}`
  return UNUSABLE_KEY
}

/**
 * The key every candidate naming no single target collapses onto.
 *
 * They have nothing to key BY, which is the whole reason `planRouteProbes` labels one by its
 * position rather than by a value. Named so the comparison below can COUNT them instead of
 * folding them into a set that cannot see their number change.
 */
const UNUSABLE_KEY = 'x:'

/** Whether two candidate lists name the same SET of targets (order and labels are cosmetic). */
function sameCandidateSet(
  a: readonly EnvironmentRouteCandidate[],
  b: readonly EnvironmentRouteCandidate[],
): boolean {
  const left = targetKeys(a)
  const right = targetKeys(b)
  if (left.size !== right.size || ![...left].every((key) => right.has(key))) return false
  // The unusable entries are COUNTED, because a set cannot tell one from four: every one of them
  // carries {@link UNUSABLE_KEY}, so a provider that starts stating an extra entry naming nothing
  // would keep a stale `not_reached` proof while `planRouteProbes` records one more
  // `address_refused` attempt than that proof knows about. Their POSITION is deliberately not part
  // of it, matching the rest of this comparison: they render identically, so reordering them
  // changes nothing a proof could be a finding about.
  return countUnusable(a) === countUnusable(b)
}

/** The deduplicated keys of the candidates that name a target, ignoring the ones that name none. */
function targetKeys(entries: readonly EnvironmentRouteCandidate[]): Set<string> {
  return new Set(entries.map(candidateKey).filter((key) => key !== UNUSABLE_KEY))
}

function countUnusable(entries: readonly EnvironmentRouteCandidate[]): number {
  return entries.filter((entry) => candidateKey(entry) === UNUSABLE_KEY).length
}

/**
 * How long a proof holds the prober off, once one has run.
 *
 * The bound on the poll path's re-prove. A status poll runs on a ten-second cadence inside the
 * deployer's readiness wait, and a proof costs up to `MAX_PROBED_ADDRESSES + 1` sequential dials
 * at `ROUTE_PROBE_TIMEOUT_MS` each: an environment whose provider genuinely re-states a different
 * candidate set every answer (a balancer scaling across zones) would drop and re-take its proof on
 * every poll, turning a poll that took milliseconds into twenty seconds of blocking I/O inside a
 * durable step, over and over. A minute means at most one probe sequence per environment per
 * minute, which is still promptly enough for the case the re-prove exists for: a proof invalidated
 * once, by a provider that then stays put.
 *
 * It paces the refresh of a proof that SURVIVED the fold too (see {@link awaitsAnotherLook}), and
 * for the same reason: a resolved `via` is re-taken as often as this allows and no oftener.
 */
export const ROUTE_REPROVE_MIN_INTERVAL_MS = 60_000

/**
 * Whether this poll should re-take the route proof, leave what the fold produced, or hold off.
 *
 * `held` is its own answer rather than a second `keep`, so the caller can SAY that a probe was due
 * and skipped instead of leaving a poll that looks identical to one with nothing to prove.
 *
 * Four narrowings, each of which was a real cost or a real omission:
 *
 *   - **Only a `ready` environment.** One that has gone back to `provisioning` is not worth
 *     dialling yet and its own settle path will prove it when it comes up; probing here would
 *     record a `not_reached` about an environment mid-rollout.
 *   - **Never the FIRST look.** Nothing has looked at a provisioning environment, and looking here
 *     would put a probe on every poll of every environment whose deployer has not settled it. The
 *     settle path owns that one.
 *   - **A surviving proof is left alone unless it {@link awaitsAnotherLook}.** The fold decides
 *     whether a proof still says something about the candidates beside it; that decides whether
 *     what it says is still worth standing on.
 *   - **{@link ROUTE_REPROVE_MIN_INTERVAL_MS} since the last look**, read off `probedAt` rather
 *     than off the proof, because a hold PERSISTS the drop: anchored on the proof's own date, the
 *     first hold would erase the anchor and no later poll would ever re-take anything.
 */
export function routeReproveDecision(args: {
  stored: EnvironmentReachability | null
  folded: EnvironmentReachability | null
  ready: boolean
  /**
   * Whether this deployment can turn a stated NAME into an address, i.e. whether its
   * `HostResolver` is wired. Read by {@link awaitsAnotherLook}, which re-takes a proof recording
   * that it was NOT only once it is.
   */
  canResolveHosts: boolean
  now: number
}): 'reprove' | 'keep' | 'held' {
  if (!args.ready) return 'keep'
  const lookedAt = lastLookedAt(args.stored)
  if (lookedAt === null) return 'keep'
  const surviving = args.folded?.proof
  if (surviving && !awaitsAnotherLook(surviving, args.canResolveHosts)) return 'keep'
  return args.now - lookedAt < ROUTE_REPROVE_MIN_INTERVAL_MS ? 'held' : 'reprove'
}

/**
 * Whether a proof that survived the fold is one the poll should take AGAIN.
 *
 * Three cases, and each is a proof about the PLATFORM wearing a state that reads like a verdict:
 *
 *   - **`unproved`.** Nothing was wired to open a socket, so it is a proof never taken, and it
 *     survives set equality forever. The caller only consults this with a prober in hand, so
 *     re-taking it is precisely "the deployment gained the capability the proof records lacking".
 *   - **`resolver_unavailable`.** The same fact one layer down, and it arrived carrying the same
 *     trap in a shape the rule above cannot see: the proof is `inconclusive`, so it is not
 *     `unproved`, so it would be left alone for the life of the environment and an environment
 *     settled by a facade with no resolver would stay unproved after the deployment wired one.
 *     Gated on the capability rather than re-taken unconditionally, because with nothing still
 *     wired the re-probe would pay a full dial sequence a minute to re-derive an answer it has.
 *   - **A `reached` proof whose `via` was RESOLVED from a name.** `via` is the literal a container
 *     host bridge is built from, and for a resolved name it is a snapshot of an address set the
 *     platform does not own. The balancer rescaling this proof deliberately SURVIVES (the name is
 *     still stated, so the fold keeps it) is the same event that releases that address, and left
 *     alone the row goes on publishing a bridge target the vendor has since handed to someone
 *     else: a run heading for failure with a proof on the record saying the environment is
 *     reachable, which is the worst of the bridge module's failure modes. Re-taking refreshes the
 *     literal against the name that is still the finding.
 *
 * Every other proof is left alone. `probe_failed` is a transient with no signal to pace against,
 * so re-taking it would be a guess on the poll's own cadence rather than a response to anything,
 * and `not_attempted` records a bound this build does not move.
 *
 * The residual gap is the environment nothing polls between the settle that proved it and the
 * dispatch that bridges to it: this can only refresh a literal where a poll happens. ADR 0064
 * records it.
 */
function awaitsAnotherLook(proof: EnvironmentRouteProof, canResolveHosts: boolean): boolean {
  if (proof.state === 'unproved') return true
  if (proof.reason === ('resolver_unavailable' satisfies EnvironmentUnreachableReason)) {
    return canResolveHosts
  }
  return proof.state === 'reached' && proof.viaHost !== undefined
}
