// Whether a `ready` environment can actually be REACHED, as opposed to whether it was
// provisioned.
//
// These are two questions, and the platform only ever asked the first one. An environment
// carries one nullable `url`, so "reachable" has meant "a URL exists"; the tester is then handed
// a name, gets `curl` exit code 000, and reports the one hypothesis its own task makes salient,
// that the ENVIRONMENT is down. That reading is wrong often enough to be expensive: a name that
// does not resolve, a route that does not carry, and an application that answers 503 are three
// different faults with three different owners, and a connection failure renders all three
// identically.
//
// The vocabulary here is the platform's answer to the LOWER two layers. It is deliberately a
// SIBLING of `EnvironmentFailureReason` rather than an extension of it: that one is
// provisioning-scoped in every member and in its docstring (`cluster_unreachable` means the
// PROVIDER could not be reached), and a reaching failure against an environment the provider
// calls `ready` is a different question for a different audience. Only the one-word verdict the
// DEPLOYER settles on lives over there (`environment_unreachable`), because the deployer settles
// in that vocabulary.

import * as v from 'valibot'

/**
 * One address a provider states will carry traffic for its environment's URL host.
 *
 * The motivating shape is an org running per-PR preview environments whose per-environment DNS
 * record lives in an internal view while the load balancers fronting it are ordinary names and
 * the ingress routes on the `Host` header. The address exists and a container's egress reaches
 * it. The only missing thing is a name-to-address mapping, which is exactly what a hosts-file
 * entry (or a Kubernetes `hostAliases` entry) is.
 *
 * `label` is for the human reading a diagnostic ("internal ALB", "public ALB"), never for
 * matching: the platform picks by PROBING, never by name.
 */
export const environmentAddressSchema = v.object({
  /** An IP literal. Never a name: a name would just be the lookup that already failed. */
  address: v.string(),
  /** What this address IS, for the diagnostic. Never load-bearing. */
  label: v.optional(v.string()),
})
export type EnvironmentAddress = v.InferOutput<typeof environmentAddressSchema>

/**
 * Why a `ready` environment could not be reached, at the layer the platform can observe.
 *
 * Separate members rather than one "unreachable" because they need different reactions and name
 * different owners: `name_unresolved` with candidates that also failed is an environment nobody
 * can reach, `no_candidate` is a PROVIDER that never told us where the thing lives, and
 * `connection_refused` is a route that carries to a box with nothing listening, which is the
 * deployed workload rather than the network.
 *
 *  - `no_candidate`       the environment carries no URL, or one with no host to probe. There
 *                         was nothing to try, which is not the same as trying and failing.
 *  - `name_unresolved`    the URL's host resolved nowhere, and no stated address carried either.
 *  - `no_route`           something resolved and the connect never completed (timeout,
 *                         host/network unreachable). The expensive failure: a lookup that
 *                         worked followed by a connect that hangs.
 *  - `connection_refused` the route carries and nothing is listening on the port.
 *  - `probe_failed`       the probe itself errored in a way it could not classify. Kept apart
 *                         from the three above so "we could not tell" never renders as a
 *                         verdict about the environment.
 */
export const environmentUnreachableReasonSchema = v.picklist([
  'no_candidate',
  'name_unresolved',
  'no_route',
  'connection_refused',
  'probe_failed',
])
export type EnvironmentUnreachableReason = v.InferOutput<typeof environmentUnreachableReasonSchema>

/** One target the proof tried, in the order it was tried, and what came back. */
export const environmentRouteAttemptSchema = v.object({
  /** `host:port` for the name itself, `host@address:port` for a stated address. */
  target: v.string(),
  /** `carried`, or the {@link EnvironmentUnreachableReason} that target produced. */
  outcome: v.string(),
})
export type EnvironmentRouteAttempt = v.InferOutput<typeof environmentRouteAttemptSchema>

/**
 * What the platform PROVED about reaching an environment, once, at the moment it went `ready`.
 *
 * `state` has three members and the third is the one that earns the type. `reached` and
 * `not_reached` are verdicts about the environment; `unproved` is a verdict about the PLATFORM
 * (nothing was wired to open a socket, so nothing was tried). Collapsing `unproved` into
 * `not_reached` would fail runs on a deployment that simply cannot probe, and collapsing it into
 * `reached` would hand the tester the same unbacked claim this whole module exists to retire.
 */
export const environmentRouteProofSchema = v.object({
  state: v.picklist(['reached', 'not_reached', 'unproved']),
  /**
   * The stated address that CARRIED, or null when the URL's own name carried (the ordinary case)
   * and when nothing carried at all. Read `state` to tell those two apart.
   *
   * This is the field a container bridge is built from, which is why the proof publishes the
   * candidate that carried rather than the first that resolved: a bridge built from an unproved
   * address is recorded as successfully applied while the tester still fails, and the evidence
   * then points further from the cause than no bridge at all did.
   */
  via: v.nullable(v.string()),
  /**
   * The {@link EnvironmentUnreachableReason} when `state` is `not_reached`, else null. An open
   * string on the wire so a stored proof written by an older build never fails to parse; readers
   * that branch on it treat an unknown value as "not one of the cases I handle".
   */
  reason: v.nullable(v.string()),
  /** Every target tried, in order. Recorded whether or not one carried. */
  attempts: v.array(environmentRouteAttemptSchema),
  /** When the proof ran (epoch ms). */
  checkedAt: v.number(),
})
export type EnvironmentRouteProof = v.InferOutput<typeof environmentRouteProofSchema>

/**
 * Everything the platform knows about ADDRESSING an environment, beside the one string it knows
 * about naming it.
 *
 * Two halves because they come from two places and one of them is a claim: `candidates` is what
 * the PROVIDER said, `proof` is what the platform TRIED. Keeping the claim after the proof runs
 * is deliberate: an operator debugging a dead environment wants to see which addresses were
 * offered as well as which were reached, and a re-probe on a later poll re-reads the same claim.
 */
export const environmentReachabilitySchema = v.object({
  /** Addresses the provider states carry traffic for the URL's host, in ITS preference order. */
  candidates: v.array(environmentAddressSchema),
  /** What proving found, or null when nothing has probed this environment yet. */
  proof: v.nullable(environmentRouteProofSchema),
})
export type EnvironmentReachability = v.InferOutput<typeof environmentReachabilitySchema>

/**
 * The reachability facts an agent (or a container dispatch) is handed for ONE environment it is
 * being pointed at.
 *
 * A flattened projection rather than the stored shape, because the reader's question is narrower
 * than the operator's: it needs the address it may dial and the layer that failed, not the
 * provider's full candidate list. `state: 'reached'` with no `address` means the name itself
 * carried, which is the case that needs no narration at all.
 */
export interface EnvironmentReachabilityNote {
  state: EnvironmentRouteProof['state']
  /** The address that carried, when the name did not. */
  address?: string
  reason?: string
}

/**
 * Project a stored {@link EnvironmentReachability} onto the note an agent or a dispatch reads, or
 * undefined when there is nothing yet to say.
 *
 * Undefined for an unprobed environment rather than a `state: 'unproved'` note, because those two
 * are different facts: "nothing has looked" is the ordinary state of an environment mid-provision,
 * and narrating it on every prompt would train a reader to skip the section that matters.
 */
export function reachabilityNote(
  reachability: EnvironmentReachability | null | undefined,
): EnvironmentReachabilityNote | undefined {
  const proof = reachability?.proof
  if (!proof) return undefined
  return {
    state: proof.state,
    ...(proof.via ? { address: proof.via } : {}),
    ...(proof.reason ? { reason: proof.reason } : {}),
  }
}
