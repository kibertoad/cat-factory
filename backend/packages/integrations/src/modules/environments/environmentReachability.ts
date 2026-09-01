// Proving that a provisioned environment can be reached, and keeping the claim and the proof in
// step as the provider re-states one and the platform re-runs the other.
//
// The RULE lives in kernel (`planRouteProbes` / `reduceRouteProof`), which is also where the
// reasoning is: why the name is tried first, why the provider's order is kept for the addresses,
// and why an unwired prober records `unproved` rather than a failure. What lives here is the URL
// half plus the sequencing, for the same reason `runtimes/local/src/environmentBridge.ts` exists:
// kernel compiles with no `URL`.

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
  recordRouteAttempt,
  reduceRouteProof,
  unprovedRoute,
} from '@cat-factory/kernel'

/** Host + port to dial for an environment URL, or null when it names neither. */
function coordinatesOf(url: string | null | undefined): { host: string; port: number } | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  const port = parsed.port
    ? Number(parsed.port)
    : scheme === 'https'
      ? 443
      : scheme === 'http'
        ? 80
        : 0
  if (!parsed.hostname || !port || !Number.isFinite(port)) return null
  return { host: parsed.hostname, port }
}

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
 */
export async function proveEnvironmentRoute(
  url: string | null | undefined,
  candidates: readonly EnvironmentAddress[],
  deps: { probe?: RouteProbe; clock: Clock },
): Promise<EnvironmentRouteProof> {
  const now = deps.clock.now()
  if (!deps.probe) return unprovedRoute(now)
  const coords = coordinatesOf(url)
  const targets = planRouteProbes(coords?.host, coords?.port, candidates)
  const attempts: EnvironmentRouteAttempt[] = []
  for (const target of targets) {
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
 * It survives only while BOTH inputs it was derived from are unchanged: the URL it dialled and the
 * candidate list it drew from. Either moving means the stored verdict is about a target that no
 * longer exists, and keeping it there is how a stale `reached` comes to vouch for an address the
 * provider has since replaced. Dropping it costs one re-probe on the next settle.
 */
export function foldStatedAddresses(
  previous: EnvironmentReachability | null,
  previousUrl: string | null,
  addresses: readonly EnvironmentAddress[] | null | undefined,
  url: string | null,
): EnvironmentReachability | null {
  const candidates = [...(addresses ?? [])]
  const unchanged = previousUrl === url && sameAddresses(previous?.candidates ?? [], candidates)
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
