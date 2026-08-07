// The composition root: everything a request needs, assembled from the environment once.
//
// It also holds the two flows that are neither pure policy nor pure transport: enrolling this
// Gatekeeper as an outbound webhook endpoint, and taking delivery of one.

import { CatFactoryClient } from '@cat-factory/sdk'
import { buildCapability } from './capability'
import { requireVar, type GatekeeperEnv } from './env'
import { GatekeeperError } from './errors'
import { KeyBroker, type Actor } from './keys'
import { compilePolicy, tierForActor, type CompiledPolicy } from './policy'
import { POLICY } from './policy.config'
import type { GatekeeperState } from './state'
import { cardEffectOf, PARKED_DECISION_CARD_TYPES, readDelivery } from './webhook/delivery'
import { verifyDelivery, type VerificationResult } from './webhook/signature'

/** Identifies this integration in the deployment's logs, beside the SDK's own version. */
const USER_AGENT = 'cat-factory-gatekeeper'

/** Why a delivery was refused, drawn from the verifier so the two cannot drift. */
type RejectionReason = Extract<VerificationResult, { ok: false }>['reason']

/** What taking delivery of one webhook POST did. */
export type DeliveryOutcome =
  | { handled: 'rejected'; reason: RejectionReason }
  | { handled: 'unparseable' }
  | { handled: 'duplicate'; deliveryId: string }
  | { handled: 'accepted'; deliveryId: string; card: 'opened' | 'superseded' | 'none' }

export class Gatekeeper {
  readonly #env: GatekeeperEnv
  readonly #policy: CompiledPolicy
  readonly #state: DurableObjectStub<GatekeeperState>
  readonly #keys: KeyBroker

  private constructor(env: GatekeeperEnv, policy: CompiledPolicy) {
    this.#env = env
    this.#policy = policy
    const baseUrl = requireVar(env, 'CAT_FACTORY_BASE_URL')
    const clientFor = (apiKey: string) =>
      new CatFactoryClient({ baseUrl, apiKey, userAgent: USER_AGENT })

    // One durable object per PAIRED DEPLOYMENT, named for the origin it is paired with. The name
    // is the pairing's own identity, so pointing this Worker at a different cat-factory gets a
    // different object rather than inheriting the previous one's cards and minted keys.
    this.#state = env.STATE.get(env.STATE.idFromName(baseUrl))
    this.#keys = new KeyBroker({
      state: this.#state,
      provisioning: clientFor(requireVar(env, 'PROVISIONING_KEY')),
      clientFor,
      now: () => Date.now(),
    })
  }

  /** Assemble, compiling the policy. Throws `PolicyError` on a policy an operator has to fix. */
  static create(env: GatekeeperEnv): Gatekeeper {
    return new Gatekeeper(env, compilePolicy(POLICY))
  }

  /** Whether the presented bearer token is this Gatekeeper's own. */
  authorize(header: string | null): boolean {
    const expected = requireVar(this.#env, 'OS_SHARED_TOKEN')
    const presented = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : ''
    return timingSafeEqualStrings(presented, expected)
  }

  /**
   * The capability for one actor the OS has authenticated.
   *
   * The tier is resolved from the Gatekeeper's OWN policy, never from anything the caller sent:
   * an agent that could name its tier would be its own authorization.
   */
  capabilityFor(actor: Actor) {
    const tier = tierForActor(this.#policy, actor.id)
    if (tier === null) {
      throw new GatekeeperError(
        'unknown_actor',
        `No tier is granted to '${actor.id}'. Add a grant in policy.config.ts, or set a ` +
          'defaultTier if this deployment means every OS user to have one.',
      )
    }
    return buildCapability({ actor, tier, keys: this.#keys, state: this.#state })
  }

  /**
   * Register this Worker as a named outbound webhook endpoint, idempotently.
   *
   * Safe to call on every cron tick and on demand: the route is keyed on the caller-chosen id, so
   * re-asserting the registration heals a deployment whose endpoint was edited or removed without
   * ever displacing a sibling integration's slot.
   */
  async enroll(): Promise<{ webhookId: string; url: string }> {
    const webhookId = requireVar(this.#env, 'WEBHOOK_ID')
    const url = new URL('/webhook', requireVar(this.#env, 'PUBLIC_URL')).toString()
    const provisioning = new CatFactoryClient({
      baseUrl: requireVar(this.#env, 'CAT_FACTORY_BASE_URL'),
      apiKey: requireVar(this.#env, 'PROVISIONING_KEY'),
      userAgent: USER_AGENT,
    })
    await provisioning.webhook.setNamed(webhookId, {
      url,
      name: 'Cloudflare OS gatekeeper',
      secret: requireVar(this.#env, 'WEBHOOK_SECRET'),
      enabled: true,
      // Subscribe to exactly the card types the inbox can act on, rather than leaving `types`
      // unset for the platform's default tail: the defaults and this Gatekeeper's list are close
      // but not equal, and the gap would arrive as cards that never appear (a type acted on but
      // not subscribed) or cards nobody can answer (the reverse).
      types: [...PARKED_DECISION_CARD_TYPES],
      // The lifecycle family is what lets a status Gadget close a run out without polling. It is
      // opt-in per event on purpose, so name all three: a Gatekeeper that hears only `run.started`
      // shows every run as forever in flight.
      runEvents: ['run.started', 'run.completed', 'run.failed'],
    })
    return { webhookId, url }
  }

  /**
   * Take delivery of one webhook POST.
   *
   * Order matters and is the whole security story of this method: verify the MAC over the RAW
   * bytes FIRST, dedupe SECOND, act THIRD. Parsing before verifying would run this deployment's
   * JSON decoder over unauthenticated input, and acting before deduping would raise a card twice
   * for one at-least-once terminal event.
   */
  async takeDelivery(request: Request, now: number): Promise<DeliveryOutcome> {
    const rawBody = await request.text()
    const verdict = await verifyDelivery(
      request.headers,
      rawBody,
      requireVar(this.#env, 'WEBHOOK_SECRET'),
      now,
    )
    if (!verdict.ok) return { handled: 'rejected', reason: verdict.reason }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return { handled: 'unparseable' }
    }
    const delivery = readDelivery(parsed)
    if (delivery === null) return { handled: 'unparseable' }

    if (!(await this.#state.recordDelivery(delivery.deliveryId, now))) {
      return { handled: 'duplicate', deliveryId: delivery.deliveryId }
    }

    const effect = cardEffectOf(delivery)
    if (effect.kind === 'open') {
      await this.#state.openCard(effect.card)
      return { handled: 'accepted', deliveryId: delivery.deliveryId, card: 'opened' }
    }
    if (effect.kind === 'supersede') {
      await this.#state.resolveCard(effect.cardId, 'superseded', now)
      return { handled: 'accepted', deliveryId: delivery.deliveryId, card: 'superseded' }
    }
    return { handled: 'accepted', deliveryId: delivery.deliveryId, card: 'none' }
  }
}

/**
 * Compare two secrets without an early exit on the first differing character.
 *
 * Lengths are compared first and that difference does leak, which is acceptable for a token the
 * caller supplies: the alternative (hashing both to a fixed width) buys nothing here, since the
 * expected token's length is a deployment constant an attacker cannot vary their way into.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
