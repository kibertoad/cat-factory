// The two refusals a Gatekeeper makes, kept apart because they need different fixes.
//
// A `PolicyError` is the OPERATOR's: the policy this deployment handed the Gatekeeper names
// something the surface does not have, or grants something its key could never call. (Named by
// what it IS, never by the file it arrived in: that file is the operator's to place, and the
// template's `policy.config.ts` is one choice of name rather than this package's to assume.) It is
// raised while the policy is compiled, before any capability exists, so a misconfigured Gatekeeper
// serves nothing rather than serving a capability whose every method 403s.
//
// A `GatekeeperError` is the CALLER's: a request that reached a live Gatekeeper and was refused
// by it (an unknown actor, an approval card that no longer exists). It carries a machine-readable
// `reason` for the same purpose the platform's own `details.reason` serves: an OS Gadget maps it
// to copy and a remedy, and prose is what a human reads afterwards.

/** A refusal the operator fixes, raised while compiling the policy. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

/** Every machine-readable cause a live Gatekeeper answers with. */
export type GatekeeperReason =
  | 'unknown_actor'
  | 'unknown_tier'
  | 'binding_not_granted'
  | 'card_not_found'
  | 'card_already_resolved'
  | 'unsupported_action'
  /** The verb needs a field the caller did not send. Named rather than defaulted. */
  | 'invalid_answer'
  /** The run holds no pending decision of the kind the caller named. */
  | 'no_such_park'
  /** The run is parked on more than one thing and the caller named none. */
  | 'ambiguous_park'
  /** The platform sent a parked decision without the id every answer to it addresses. */
  | 'malformed_decision'
  /** A minted credential was refused upstream and re-minting it was refused too. */
  | 'credential_rejected'
  /** The workspace decided against a submitted action, so it was never performed. */
  | 'action_rejected'
  /** A decision named an action id this resource is not holding: already settled, or not ours. */
  | 'unknown_action'
  /** The session that submitted an action went away before the workspace decided it. */
  | 'session_ended'
  /** The URL the workspace asked for is not one this Gatekeeper serves. */
  | 'no_such_resource'
  /** Sharing an observation onward was refused: the observer could not read all of it directly. */
  | 'sharing_refused'
  /** Sharing was refused because the observer could not be identified at all. */
  | 'sharing_unverifiable'
  /** The call carries an argument the operation does not declare, so it would have been dropped. */
  | 'undeclared_argument'
  /** The call omits an argument the operation requires. */
  | 'missing_argument'
  /** This door serves no hooks: it has no approval queue to register one with. */
  | 'hooks_unavailable'
  /** The workspace's own side did not take a hook binding, and said why. */
  | 'hook_bind_refused'
  /** The deployment's entry module does not export something the OS object model needs. */
  | 'missing_export'

/** A refusal the caller (or the OS deployment operating it) acts on. */
export class GatekeeperError extends Error {
  readonly reason: GatekeeperReason

  constructor(reason: GatekeeperReason, message: string) {
    super(message)
    this.name = 'GatekeeperError'
    this.reason = reason
  }
}

/**
 * A failure as a refusal or a record carries it: one line, never an object nothing can render.
 *
 * Here rather than beside each caller because three of them (a hook push, a bind the workspace did
 * not take, a verifier that could not be questioned) fold a cause into prose a person reads, and
 * three copies of the same two lines is how they drift into disagreeing about what an
 * `AggregateError` or a thrown string looks like.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
