// The two refusals a Gatekeeper makes, kept apart because they need different fixes.
//
// A `PolicyError` is the OPERATOR's: this deployment's `policy.config.ts` names something the
// surface does not have, or grants something its key could never call. It is raised while the
// policy is compiled, before any capability exists, so a misconfigured Gatekeeper serves nothing
// rather than serving a capability whose every method 403s.
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

/** A refusal the caller (or the OS deployment operating it) acts on. */
export class GatekeeperError extends Error {
  readonly reason: GatekeeperReason

  constructor(reason: GatekeeperReason, message: string) {
    super(message)
    this.name = 'GatekeeperError'
    this.reason = reason
  }
}
