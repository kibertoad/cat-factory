// Proving that a provisioned environment can be reached, and keeping the claim and the proof in
// step as the provider re-states one and the platform re-runs the other.
//
// The RULE lives in kernel (`planRouteProbes` / `reduceRouteProof`), which is also where the
// reasoning is: why the name is tried first, why the provider's order is kept for the addresses,
// which addresses the platform will not dial, and why an unwired prober records `unproved` rather
// than a failure. What lives here is the sequencing.
//
// Where the URL is turned into coordinates is `@cat-factory/contracts`
// (`deriveEnvironmentCoordinates`), the ONE deriver, shared with the Tester prompt that states
// those same coordinates to an agent. A second parser here would let the platform dial one host
// and tell the agent another.

import { deriveEnvironmentCoordinates } from '@cat-factory/contracts'
import type {
  Clock,
  EnvironmentAddress,
  EnvironmentReachability,
  EnvironmentRouteAttempt,
  EnvironmentRouteProof,
  RouteProbe,
} from '@cat-factory/kernel'
import {
  planRouteProbes,
  recordRefusedAttempt,
  recordRouteAttempt,
  reduceRouteProof,
  unprovedRoute,
} from '@cat-factory/kernel'

/**
 * Dial an environment's name and then, in the provider's order, each address it stated for that
 * name. Stops at the first target that CARRIES and publishes that one.
 *
 * Sequential rather than raced, deliberately. The provider's order is its own statement about
 * which balancer it wants used (an internal one ahead of a public one, say), and racing would
 * publish whichever answered fastest, which is a different question and one nobody asked. The cost
 * is bounded by `MAX_PROBED_ADDRESSES` times the per-probe timeout, against a misdiagnosis that
 * currently costs a whole tester step.
 *
 * With no prober wired the result is `unproved`, never a failure: a facade that cannot open a
 * socket behaves exactly as it did before this existed.
 *
 * A target the plan REFUSED is recorded without a socket being opened. That is the one place the
 * two kinds of target must not be conflated, and why the plan makes a refused one carry no
 * request to dial.
 */
export async function proveEnvironmentRoute(
  url: string | null | undefined,
  candidates: readonly EnvironmentAddress[],
  deps: { probe?: RouteProbe; clock: Clock },
): Promise<EnvironmentRouteProof> {
  const now = deps.clock.now()
  if (!deps.probe) return unprovedRoute(now)
  const coords = deriveEnvironmentCoordinates(url)
  const targets = planRouteProbes(coords?.host, coords?.port, candidates)
  const attempts: EnvironmentRouteAttempt[] = []
  for (const target of targets) {
    if (target.kind === 'refused') {
      attempts.push(recordRefusedAttempt(target))
      continue
    }
    const outcome = await deps.probe(target.request)
    attempts.push(recordRouteAttempt(target, outcome))
    if (outcome.state === 'carried') return reduceRouteProof(attempts, target.address, now)
  }
  return reduceRouteProof(attempts, null, now)
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
 *   - a `reached` proof is a finding about ONE target: the address in `via`, or the name itself
 *     when `via` is null. It survives while that target is still on offer, which for `via` means
 *     still being among the stated candidates and for the name means nothing further, the URL
 *     having already been checked. A provider adding a fallback candidate is strictly MORE
 *     information and cannot invalidate a proof about an address it did not touch.
 *   - every other proof is a finding about the whole list that was TRIED, so it survives only
 *     while the candidate SET is unchanged. A new candidate is a target nothing ever dialled, and
 *     "nothing reaches this environment" is no longer established once one exists.
 *
 * A dropped proof costs a re-probe, and {@link EnvironmentProvisioningService.refreshStatus} takes
 * one for a `ready` environment rather than leaving the row to be re-proved by a deployer settle
 * that will not run again for that frame: a dropped proof and a proof never taken are the same
 * value, so nothing downstream could tell that the feature had stopped working.
 */
export function foldStatedAddresses(
  previous: EnvironmentReachability | null,
  previousUrl: string | null,
  addresses: readonly EnvironmentAddress[] | null | undefined,
  url: string | null,
): EnvironmentReachability | null {
  const stored = previous?.candidates ?? []
  const candidates = addresses ? [...addresses] : [...stored]
  const proof =
    previousUrl === url ? survivingProof(previous?.proof ?? null, stored, candidates) : null
  if (candidates.length === 0 && !proof) return null
  return { candidates, proof }
}

/** A stored proof that still says something about the freshly stated candidates, or null. */
function survivingProof(
  proof: EnvironmentRouteProof | null,
  stored: readonly EnvironmentAddress[],
  candidates: readonly EnvironmentAddress[],
): EnvironmentRouteProof | null {
  if (!proof) return null
  if (proof.state === 'reached') {
    return !proof.via || candidates.some((entry) => entry.address === proof.via) ? proof : null
  }
  return sameAddressSet(stored, candidates) ? proof : null
}

/** Whether two candidate lists name the same SET of addresses (order and labels are cosmetic). */
function sameAddressSet(
  a: readonly EnvironmentAddress[],
  b: readonly EnvironmentAddress[],
): boolean {
  const left = new Set(a.map((entry) => entry.address))
  const right = new Set(b.map((entry) => entry.address))
  return left.size === right.size && [...left].every((address) => right.has(address))
}
