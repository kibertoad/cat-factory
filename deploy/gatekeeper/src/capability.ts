// The object-capability itself: what an OS workspace agent actually holds.
//
// The design rule that makes this a capability rather than a permission check is that the granted
// operations are the object's METHODS. A tier without `tasks_delete` does not get a `tasks_delete`
// that refuses; it gets an object with no such method, so the refusal is a `TypeError` from the
// caller's own runtime and there is no allow-list to get backwards. What policy CAN still get
// wrong (which names are granted) is checked once, at compile time, against the live operation
// table; what it cannot get wrong is checked by JavaScript.
//
// Methods live on a per-session PROTOTYPE, never on the instance. Cap'n Web deliberately refuses
// to serve an RpcTarget's own instance properties (they would leak private internals), so an
// instance-property capability would be a set of methods no caller can reach.

import { RpcTarget } from 'capnweb'
import type { GatekeeperBinding } from '@cat-factory/gatekeeper-bindings'
import { answerCard, assertAnswerable, type AnswerInput, type AnswerOutcome } from './approvals'
import { GatekeeperError, PolicyError } from './errors'
import type { Actor, KeyBroker } from './keys'
import { applyMask } from './masking'
import { describeBinding, type CompiledTier } from './policy'
import type { ApprovalCard, GatekeeperState } from './state'

/**
 * The methods a capability carries beyond its granted bindings.
 *
 * Reserved rather than merely used: a future `/api/v1` resource group called `approvals` would
 * generate a binding named `approvals_list`, and silently overwriting one of these with it (or
 * the other way round) is the kind of collision that reads as a missing feature. It is checked at
 * build time and refused as a policy error, because the fix is a rename in this file.
 */
const RESERVED_METHODS = [
  'tier',
  'bindings',
  'withheld',
  'approvals_list',
  'approvals_answer',
] as const

export interface SessionDependencies {
  actor: Actor
  tier: CompiledTier
  keys: KeyBroker
  state: DurableObjectStub<GatekeeperState>
}

/** What `tier()` answers: enough for an OS Gadget to render who the caller is acting as. */
export interface TierSummary {
  actorId: string
  tier: string
  description: string
  keyScope: string
}

/**
 * Build the capability for one connected actor.
 *
 * Returns an `RpcTarget` whose prototype carries exactly the granted operations plus the reserved
 * methods above. Each call resolves the actor's own key (minted once, cached durably) and
 * forwards through the binding's `invoke` thunk, so retry, encoding and error mapping stay the
 * SDK's job and this layer only ever decides WHO and WHETHER.
 */
export function buildCapability(deps: SessionDependencies): RpcTarget {
  const { tier } = deps
  const granted = new Map<string, GatekeeperBinding>(
    tier.granted.map((binding) => [binding.name, binding]),
  )

  for (const reserved of RESERVED_METHODS) {
    if (granted.has(reserved)) {
      throw new PolicyError(
        `Binding '${reserved}' collides with a reserved capability method. Rename the reserved ` +
          'method in capability.ts; a granted operation must never be shadowed by one.',
      )
    }
  }

  const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const binding = granted.get(name)
    if (binding === undefined) {
      throw new GatekeeperError(
        'binding_not_granted',
        `Tier '${tier.name}' does not grant '${name}'.`,
      )
    }
    const client = await deps.keys.clientFor(deps.actor, tier.keyScope)
    return applyMask(await binding.invoke(client, args), tier.mask)
  }

  class Capability extends RpcTarget {}
  const proto = Capability.prototype as unknown as Record<string, unknown>

  for (const binding of tier.granted) {
    proto[binding.name] = (args: Record<string, unknown> = {}) => invoke(binding.name, args)
  }

  proto.tier = (): TierSummary => ({
    actorId: deps.actor.id,
    tier: tier.name,
    description: tier.description,
    keyScope: tier.keyScope,
  })

  // The two halves of "what can I do here", answered separately on purpose. `bindings()` carries
  // the consequence annotations with the cautious default applied, so the OS can run its own
  // approval governance over a call without re-deriving what "destructive" means.
  proto.bindings = () => tier.granted.map(describeBinding)

  // `withheld()` is the degrade-loudly half: an agent that cannot tell "your policy hides this"
  // from "this deployment does not have it" reports the wrong one to whoever has to fix it.
  proto.withheld = () => tier.withheld

  proto.approvals_list = (): Promise<ApprovalCard[]> => deps.state.listCards()

  proto.approvals_answer = async (cardId: string, input: AnswerInput): Promise<AnswerOutcome> => {
    const card = assertAnswerable(await deps.state.getCard(cardId), cardId)
    const outcome = await answerCard(card, input, invoke)
    // Only an answer that SETTLED the gate settles the card. A recorded-but-short-of-quorum
    // approval leaves the card open, because the next approver still has to see it; a stale card
    // is settled, because the decision it named is gone either way.
    if (outcome.status !== 'recorded') {
      await deps.state.resolveCard(
        cardId,
        outcome.status === 'stale' ? 'superseded' : input.action,
        Date.now(),
      )
    }
    return outcome
  }

  return new Capability()
}
