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
import {
  answerCard,
  assertAnswerable,
  pendingParks,
  describeStale,
  type AnswerInput,
  type AnswerOutcome,
  type DecisionListShape,
} from './approvals.js'
import { GatekeeperError, PolicyError } from './errors.js'
import type { Actor, KeyBroker } from './keys.js'
import { applyMask } from './masking.js'
import { describeBinding, type CompiledTier } from './policy/compile.js'
import type { ApprovalCard, GatekeeperState, RunState } from './state.js'

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
  'approvals_inspect',
  'approvals_answer',
  'runs_watched',
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
 * What `approvals_inspect()` answers: the card, what the run is ACTUALLY parked on now, and which
 * verbs this tier can reach.
 *
 * The reason this exists beside `approvals_answer` is the same one `withheld()` exists beside
 * `bindings()`: an agent composing an answer needs to know what the park takes and whether its own
 * tier holds the operation, and deriving either from a doc is how an integration ends up posting a
 * body the platform refuses with a 422 that names a field the agent never chose.
 */
export interface CardInspection {
  card: ApprovalCard
  /** The run's live decision list, verbatim. The webhook is a trigger; this is the truth. */
  decisions: unknown
  /** What the run is parked on and can be answered from here, with the verbs each takes. */
  parks: {
    kind: string
    summary: string
    actions: {
      action: string
      binding: string
      summary: string
      /** False when this tier was not granted the binding: the verb exists, this caller cannot use it. */
      granted: boolean
      fields: readonly {
        name: string
        required: boolean
        choices?: readonly string[]
        detail: string
      }[]
    }[]
  }[]
  /** Present only when nothing is answerable, saying which of the several reasons it is. */
  stale?: string
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
    const result = await deps.keys.run(deps.actor, tier.keyScope, (client) =>
      binding.invoke(client, args),
    )
    return applyMask(result, tier.mask)
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

  // The lifecycle projection the `run.*` subscription feeds. Without it those deliveries would be
  // verified, deduped and dropped, and a status Gadget would be back to polling `tasks_get_run`
  // for a transition the platform already pushed.
  proto.runs_watched = (): Promise<RunState[]> => deps.state.listRunStates()

  proto.approvals_inspect = async (cardId: string): Promise<CardInspection> => {
    const card = await deps.state.getCard(cardId)
    if (card === null) {
      throw new GatekeeperError(
        'card_not_found',
        `No approval card '${cardId}'. It may have been raised against a different paired ` +
          'workspace, or predate this Gatekeeper.',
      )
    }
    const list = (await invoke('decisions_list', { runId: card.runId })) as DecisionListShape
    const parks = pendingParks(list).map((park) => ({
      kind: park.kind,
      summary: park.summary,
      actions: park.verbs.map((verb) => ({
        action: verb.action,
        binding: verb.binding,
        summary: verb.summary,
        granted: granted.has(verb.binding),
        fields: verb.fields,
      })),
    }))
    return {
      card,
      decisions: list,
      parks,
      ...(parks.length === 0 ? { stale: describeStale(list) } : {}),
    }
  }

  proto.approvals_answer = async (cardId: string, input: AnswerInput): Promise<AnswerOutcome> => {
    const card = assertAnswerable(await deps.state.getCard(cardId), cardId)
    const outcome = await answerCard(card, input, invoke)
    // Only an answer that left the run UNPARKED settles the card. An approval short of quorum, or
    // a reply the incorporation has not folded in yet, leaves it open because the next answerer
    // still has to see it. A `stale` answer settles nothing either: the run may be held by a wait
    // a person has to clear elsewhere, and destroying the card would remove the one pointer to it
    // that the inbox had. The platform re-delivers a card under a new notification id, so a
    // wrongly settled one is never re-raised.
    if (outcome.status === 'answered') {
      await deps.state.resolveCard(cardId, `${outcome.kind}:${outcome.action}`, Date.now())
    }
    return outcome
  }

  return new Capability()
}
