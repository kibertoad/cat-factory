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
 * The proof survives only while BOTH inputs it was derived from are unchanged: the URL it dialled
 * and the candidate list it drew from. Either moving means the stored verdict is about a target
 * that no longer exists, and keeping it there is how a stale `reached` comes to vouch for an
 * address the provider has since replaced. Dropping it costs one re-probe on the next settle.
 */
export function foldStatedAddresses(
  previous: EnvironmentReachability | null,
  previousUrl: string | null,
  addresses: readonly EnvironmentAddress[] | null | undefined,
  url: string | null,
): EnvironmentReachability | null {
  const stored = previous?.candidates ?? []
  const candidates = addresses ? [...addresses] : [...stored]
  const unchanged = previousUrl === url && sameAddresses(stored, candidates)
  const proof = unchanged ? (previous?.proof ?? null) : null
  if (candidates.length === 0 && !proof) return null
  return { candidates, proof }
}

/** Whether two candidate lists name the same addresses in the same order (labels are cosmetic). */
function sameAddresses(
  a: readonly EnvironmentAddress[],
  b: readonly EnvironmentAddress[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => entry.address === b[index]?.address)
}
