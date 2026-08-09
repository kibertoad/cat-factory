// The composition root: everything a request needs, assembled from the environment once.
//
// It also holds the flows that are neither pure policy nor pure transport: enrolling this
// Gatekeeper as an outbound webhook endpoint, taking delivery of one, and retiring an actor.
//
// The POLICY arrives as an argument, never as an import. This package is the base a deployment
// installs; the policy is the one thing that deployment writes, so a `policy.config.ts` this
// module reached for would be a file the base owns and the operator cannot replace without
// forking it.

import { CatFactoryClient } from '@cat-factory/sdk'
import { buildCapability, type SessionGovernance } from './capability.js'
import { requireVar, stateFor, type GatekeeperEnv } from './env.js'
import { GatekeeperError } from './errors.js'
import { KeyBroker, type Actor } from './keys.js'
import type { HookPushTarget, HookTopic } from './os/hooks.js'
import {
  autoProvisionedTier,
  compilePolicy,
  tierForAccount,
  tierForActor,
  type CompiledPolicy,
  type CompiledTier,
  type GatekeeperPolicy,
} from './policy/compile.js'
import type { GatekeeperState } from './state.js'
import { cardEffectOf, readDelivery, SUBSCRIBED_CARD_TYPES } from './webhook/delivery.js'
import { verifyDelivery, type VerificationResult } from './webhook/signature.js'

/** Identifies this integration in the deployment's logs, beside the SDK's own version. */
const USER_AGENT = 'cat-factory-gatekeeper'

/**
 * The one remedy both auto-provisioning refusals end on.
 *
 * Stated once because the two refusals differ only in what they could not do (open a session for a
 * named account, describe the session a new one would get) and never in the fix.
 */
const AUTO_PROVISIONED_TIER_REMEDY =
  "Name a tier as the policy's autoProvisionedTier to turn Cloudflare OS discovery on; it is " +
  'deliberately separate from defaultTier, because an account the workspace minted carries no ' +
  'identity your grants could have named.'

/** Why a delivery was refused, drawn from the verifier so the two cannot drift. */
type RejectionReason = Extract<VerificationResult, { ok: false }>['reason']

/**
 * What the receiver handed to the hook fan-out, which is DISPATCH and never delivery.
 *
 * The distinction is the whole reason this shape changed. The fan-out runs behind the
 * acknowledgement, so at the moment this is reported no push has been made and any count of them
 * would be a zero standing in for a number nobody has yet: the one reading a receiver must never
 * offer, because it is indistinguishable from a delivery no hook took. What each push DID land on
 * its own registration's counters, which `hooks_bound()` publishes.
 */
export interface HookDispatchReceipt {
  /** How many payloads this delivery produced. Zero when no topic covers it. */
  pushes: number
  /** The distinct topics they carry, so the platform's delivery log names what was dispatched. */
  topics: HookTopic[]
}

/** What taking delivery of one webhook POST did. */
export type DeliveryOutcome =
  | { handled: 'rejected'; reason: RejectionReason }
  | { handled: 'unparseable' }
  | { handled: 'duplicate'; deliveryId: string }
  | {
      handled: 'accepted'
      deliveryId: string
      effect: 'opened' | 'superseded' | 'run-event' | 'none'
      hooks: HookDispatchReceipt
    }

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

    this.#state = stateFor(env)
    this.#keys = new KeyBroker({
      state: this.#state,
      provisioning: clientFor(requireVar(env, 'PROVISIONING_KEY')),
      clientFor,
      now: () => Date.now(),
    })
  }

  /**
   * Assemble against the deployment's own policy, compiling it.
   *
   * Throws a `PolicyError` on a policy an operator has to fix, and a `ConfigError` on a binding
   * they have not set. Both are refusals the request path answers as a 503 naming the cause, which
   * is why the compile happens per assembly rather than once at module load: a Worker whose policy
   * threw while its module evaluated serves nothing at all, not even the refusal that says why.
   */
  static create(env: GatekeeperEnv, policy: GatekeeperPolicy): Gatekeeper {
    return new Gatekeeper(env, compilePolicy(policy))
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
  capabilityFor(actor: Actor, governance?: SessionGovernance) {
    return this.#capability(actor, this.tierFor(actor.id), governance)
  }

  /**
   * The capability for an auto-provisioned Cloudflare OS account.
   *
   * A sibling of `capabilityFor` rather than a flag on it, because the two doors resolve a tier
   * from different halves of the policy: `/rpc` names a person the OS asserts, and an account was
   * minted here with no name at all. Everything after the resolution is the one implementation.
   */
  capabilityForAccount(accountId: string, governance: SessionGovernance) {
    return this.#capability(
      { id: accountId, label: accountId },
      this.tierForAccount(accountId),
      governance,
    )
  }

  #capability(actor: Actor, tier: CompiledTier, governance?: SessionGovernance) {
    return buildCapability({
      actor,
      tier,
      keys: this.#keys,
      state: this.#state,
      ...(governance ? { governance } : {}),
    })
  }

  /**
   * The compiled tier an actor holds, or a refusal naming what an operator has to change.
   *
   * Exposed beside `capabilityFor` because the OS object model asks about a tier without building
   * a session from it: the resource's TypeScript types and its auto-approvable action kinds are
   * both projections of the tier, and both are read before any session exists.
   */
  tierFor(actorId: string): CompiledTier {
    const tier = tierForActor(this.#policy, actorId)
    if (tier === null) {
      throw new GatekeeperError(
        'unknown_actor',
        `No tier is granted to '${actorId}'. Add them to this Gatekeeper's policy under ` +
          'grants, or set a defaultTier if this deployment means every OS user to have one.',
      )
    }
    return tier
  }

  /**
   * The tier an auto-provisioned Cloudflare OS account holds, or a refusal naming the knob.
   *
   * Separate from {@link tierFor} because the refusal has to name the right thing: a deployment
   * that has not opted into OS discovery has not misconfigured anything, and telling its operator
   * to add an actor to `grants` would be telling them to write a line for an id that did not exist
   * when they were reading.
   */
  tierForAccount(accountId: string): CompiledTier {
    const tier = tierForAccount(this.#policy, accountId)
    if (tier === null) {
      throw new GatekeeperError(
        'unknown_actor',
        'This Gatekeeper serves no auto-provisioned accounts, so it cannot open a session for ' +
          `'${accountId}'. ${AUTO_PROVISIONED_TIER_REMEDY}`,
      )
    }
    return tier
  }

  /**
   * The tier EVERY auto-provisioned account falls to, asked without an account.
   *
   * The vendor is questioned before any account exists (its published session types are the ones a
   * new account will get), and that question has an answer of its own. Asking it by minting a
   * throwaway id would resolve the same tier and, when there is none, refuse by naming an
   * `acct_…` that appears nowhere in the operator's policy.
   */
  tierForNewAccount(): CompiledTier {
    const tier = autoProvisionedTier(this.#policy)
    if (tier === null) {
      throw new GatekeeperError(
        'unknown_actor',
        'This Gatekeeper serves no auto-provisioned accounts, so there is no session for it to ' +
          `describe. ${AUTO_PROVISIONED_TIER_REMEDY}`,
      )
    }
    return tier
  }

  /**
   * The tier NAME a policy nominates for auto-provisioned accounts, or `null`.
   *
   * The raw knob rather than the compiled tier, because the one caller that wants it is `/health`,
   * reporting whether this deployment has opted into Cloudflare OS discovery at all. A refusal
   * would be the wrong shape there: not having opted in is a state, not a fault.
   */
  get autoProvisionedTierName(): string | null {
    return this.#policy.autoProvisionedTier
  }

  /**
   * Whether this deployment minted the named account.
   *
   * Asked by the ONE caller that is handed an account id from outside (`addObserver`, over an
   * observer's verifier) and has to resolve a tier for it. Every other account id in this package
   * arrives on `ctx.props` of a stub this Gatekeeper handed the workspace, so it was minted here
   * by construction and asking again would be a lookup with no question behind it.
   */
  async recognizesAccount(accountId: string): Promise<boolean> {
    return await this.#state.hasAccount(accountId)
  }

  /** The origin of the cat-factory deployment this Gatekeeper is paired with. */
  get deployment(): string {
    return requireVar(this.#env, 'CAT_FACTORY_BASE_URL')
  }

  /**
   * Retire an actor: revoke every key this Gatekeeper minted for them, upstream and here.
   *
   * Exposed on the ADMIN surface rather than on a capability, because it is the OS deployment's
   * offboarding action and not something an agent acting AS someone should be able to do to them.
   */
  async retire(actorId: string): Promise<{ revoked: string[]; remaining: string[] }> {
    return await this.#keys.revoke({ id: actorId })
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
      // Subscribe to exactly the card types the inbox raises something for, rather than leaving
      // `types` unset for the platform's default tail: the defaults and this Gatekeeper's list are
      // close but not equal, and the gap would arrive as cards that never appear (a type acted on
      // but not subscribed) or cards nobody can do anything with (the reverse). What each type
      // OFFERS is the card's `disposition`, so the list can carry a `notice` without the inbox
      // presenting it as answerable.
      types: [...SUBSCRIBED_CARD_TYPES],
      // The lifecycle family is what lets a status Gadget close a run out without polling: it
      // lands as a `runs_watched()` record, and a terminal event settles the run's open cards. It
      // is opt-in per event on purpose, so name all three: a Gatekeeper that hears only
      // `run.started` shows every run as forever in flight.
      runEvents: ['run.started', 'run.completed', 'run.failed'],
    })
    return { webhookId, url }
  }

  /**
   * Take delivery of one webhook POST.
   *
   * Order matters and is the whole security story of this method: verify the MAC over the RAW
   * bytes FIRST, parse SECOND, and hand the dedupe and the effect to durable state as ONE call.
   * Parsing before verifying would run this deployment's JSON decoder over unauthenticated input.
   * Deduping in a call of its own would be worse than useless: a marker committed before the card
   * write turns a failed write into a `duplicate` on the platform's retry, so the approval never
   * reaches the inbox and nothing anywhere reports that it did not.
   *
   * `defer` is how the fan-out is kept OFF that path, and it is a parameter rather than something
   * read here because the lifetime being extended is the Worker invocation's, which only the
   * handler holds.
   */
  async takeDelivery(
    request: Request,
    now: number,
    defer: (work: Promise<unknown>) => void,
  ): Promise<DeliveryOutcome> {
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

    const effect = cardEffectOf(delivery)
    const applied = await this.#state.applyDelivery(delivery.deliveryId, effect, now)
    if (!applied.applied) return { handled: 'duplicate', deliveryId: delivery.deliveryId }

    // AFTER the write and BESIDE the acknowledgement, never in front of it. The card is the
    // durable truth and the push is the accelerator over it, so a workspace that hangs or refuses
    // must cost a notification and never the record. Awaiting the fan-out here made it cost both:
    // one slow workspace times the delivery out, the platform retries to protect a write that had
    // already committed, and the retry is deduped into pushing nothing at all, so the notification
    // the wait was supposed to guarantee is the one thing certain to be lost.
    if (applied.pushes.length > 0) defer(this.#state.dispatchHooks(applied.pushes, now))
    return {
      handled: 'accepted',
      deliveryId: delivery.deliveryId,
      effect: applied.effect,
      hooks: receiptFor(applied.pushes),
    }
  }
}

/** What was handed to the fan-out, summarised for the platform's own delivery log. */
function receiptFor(pushes: readonly HookPushTarget[]): HookDispatchReceipt {
  return { pushes: pushes.length, topics: [...new Set(pushes.map((push) => push.topic))] }
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
