// Per-actor credentials: the reason an OS user's run is attributable at all.
//
// A Gatekeeper could forward every call on one shared workspace key, and every run would then be
// started by "the integration". That loses the two things the platform builds on the caller's
// identity: `externalIdentity` mapping a run back to a person without cat-factory holding your
// directory (slice 3), and role-scoped merge policy, which refuses a landing a shared credential
// should not make (ADR 0037/0039). So each actor gets their OWN key, minted at the tier's scope
// and stamped with their identity.
//
// Minting is CACHED, not per call. `POST /api/v1/keys` returns the raw secret exactly once, so a
// Gatekeeper that re-mints per call both spends a key row per operation and leaves a growing set
// of live credentials it has already forgotten how to revoke.
//
// Two things follow from "the mint is a real, non-idempotent side effect that returns its secret
// once", and both are the difference between a cache and a leak:
//
//   - IT IS CLAIMED BEFORE IT RUNS. A read-then-mint-then-write has two pipelined calls for one
//     actor both seeing "no key yet"; both mint, the second write wins, and the loser's key stays
//     live upstream with nothing here recording that it exists. The claim is taken atomically in
//     the Durable Object and expires, so a Worker that dies mid-mint does not wedge the actor out.
//   - A REJECTED KEY IS DROPPED, NOT RETRIED FOREVER. The documented kill switch is revoking the
//     provisioning key, which revokes every key it minted; a cache with no invalidation answers
//     every call after that with the same dead secret and a 401 nobody can clear short of wiping
//     the object. A 401 drops the row and re-mints ONCE, so a rotation heals itself and a genuinely
//     unusable credential still fails rather than looping.

import { CatFactoryClient, CatFactoryUnauthorizedError } from '@cat-factory/sdk'
import type { PublicApiScope } from '@cat-factory/gatekeeper-bindings'
import { GatekeeperError } from './errors.js'
import type { GatekeeperState, StoredKey } from './state.js'

/** Who the OS says is calling. The Gatekeeper trusts this and NOTHING else the caller sends. */
export interface Actor {
  /** The OS's own identity for the person. Rides `externalIdentity` onto every minted key. */
  id: string
  /** Optional display name, used only to label the key for a human reading the key list. */
  label?: string
}

/** The label cap the key contract enforces. */
const MAX_LABEL_LENGTH = 120

/** How many times a caller re-reads a claim another call is holding before giving up. */
const MINT_CLAIM_POLLS = 20

/** How long between those reads. Short: the claim is held across one `POST /api/v1/keys`. */
const MINT_CLAIM_POLL_MS = 100

export interface KeyBrokerDependencies {
  /** The paired workspace's durable state, holding minted keys. */
  state: DurableObjectStub<GatekeeperState>
  /** A client on the Gatekeeper's own `admin` provisioning key. */
  provisioning: CatFactoryClient
  /** Build a client on a minted key. */
  clientFor: (apiKey: string) => CatFactoryClient
  now: () => number
  /** Wait, injected so the claim-contention path is testable without real time. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * A leased client, paired with the key it is authenticated as.
 *
 * The key id travels with it because the caller needs it on failure, not on success: dropping a
 * rejected credential has to name WHICH one it is dropping, or a concurrent call that has already
 * minted the replacement loses it.
 */
export interface LeasedClient {
  client: CatFactoryClient
  keyId: string
}

export class KeyBroker {
  readonly #deps: KeyBrokerDependencies
  readonly #sleep: (ms: number) => Promise<void>

  constructor(deps: KeyBrokerDependencies) {
    this.#deps = deps
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Run one call as `actor`, at `scope`, re-minting once if the credential is rejected.
   *
   * The retry is deliberately narrow: ONE re-mint, on a 401 only, after dropping the row that
   * produced it. Anything wider would turn a genuinely unusable deployment into a mint loop, and
   * anything narrower would make the documented "rotate the provisioning key" kill switch a
   * permanent outage for every actor whose key was cached.
   *
   * The scope is the TIER's, never the caller's request: a caller asking for a better key is
   * asking the wrong side of the boundary.
   */
  async run<T>(
    actor: Actor,
    scope: PublicApiScope,
    call: (client: CatFactoryClient) => Promise<T>,
  ): Promise<T> {
    const leased = await this.#lease(actor, scope)
    try {
      return await call(leased.client)
    } catch (error) {
      if (!(error instanceof CatFactoryUnauthorizedError)) throw error
      const dropped = await this.#deps.state.forgetKeyIfCurrent(actor.id, scope, leased.keyId)
      if (!dropped) {
        // Another call already replaced it, so the credential in hand is simply stale. Retrying on
        // the replacement is the same one-shot, not a second one.
        return await call((await this.#lease(actor, scope)).client)
      }
      const fresh = await this.#lease(actor, scope)
      try {
        return await call(fresh.client)
      } catch (retryError) {
        if (!(retryError instanceof CatFactoryUnauthorizedError)) throw retryError
        throw new GatekeeperError(
          'credential_rejected',
          `A freshly minted '${scope}' key for '${actor.id}' was refused by the deployment. The ` +
            'provisioning key is the likely cause: check it is still live and still `admin`-scoped.',
        )
      }
    }
  }

  /**
   * Revoke every key minted for an actor, for when the OS says they are gone.
   *
   * Revoked UPSTREAM FIRST, then forgotten, and only what was actually revoked is forgotten. The
   * other order can leave a live cat-factory key that this Gatekeeper no longer knows exists,
   * which is a credential nobody can find to revoke; this order can at worst re-revoke an id,
   * which the platform documents as idempotent. A revoke that fails part-way leaves the rest of
   * the rows in place, so a second call finishes the job rather than losing track of them.
   */
  async revoke(actor: Actor): Promise<{ revoked: string[]; remaining: string[] }> {
    const stored = await this.#deps.state.listKeys(actor.id)
    const revoked: string[] = []
    const revokedScopes: string[] = []
    for (const { scope, key } of stored) {
      await this.#deps.provisioning.keys.revoke(key.keyId)
      revoked.push(key.keyId)
      revokedScopes.push(scope)
    }
    await this.#deps.state.forgetKeys(actor.id, revokedScopes)
    return {
      revoked,
      remaining: stored
        .filter(({ scope }) => !revokedScopes.includes(scope))
        .map(({ key }) => key.keyId),
    }
  }

  async #lease(actor: Actor, scope: PublicApiScope): Promise<LeasedClient> {
    for (let attempt = 0; attempt <= MINT_CLAIM_POLLS; attempt++) {
      const ticket = await this.#deps.state.claimKeyMint(actor.id, scope, this.#deps.now())
      if (ticket.outcome === 'existing') {
        return { client: this.#deps.clientFor(ticket.key.secret), keyId: ticket.key.keyId }
      }
      if (ticket.outcome === 'claimed') return await this.#mint(actor, scope)
      await this.#sleep(Math.min(MINT_CLAIM_POLL_MS, ticket.retryAfterMs))
    }
    throw new GatekeeperError(
      'credential_rejected',
      `Minting a '${scope}' key for '${actor.id}' is still in flight on another request after ` +
        `${MINT_CLAIM_POLLS * MINT_CLAIM_POLL_MS}ms. Retry; if it persists, the deployment's ` +
        '`POST /api/v1/keys` is failing in a way that leaves the claim to expire.',
    )
  }

  /**
   * Mint under a held claim.
   *
   * The claim is RELEASED on failure rather than left to expire: a deployment that is briefly
   * unreachable should not lock the actor out for the claim's whole TTL, and the release is safe
   * precisely because nothing was minted.
   */
  async #mint(actor: Actor, scope: PublicApiScope): Promise<LeasedClient> {
    let created: Awaited<ReturnType<CatFactoryClient['keys']['create']>>
    try {
      created = await this.#deps.provisioning.keys.create({
        label: keyLabel(actor, scope),
        scope: scope as 'read' | 'write' | 'decide',
        externalIdentity: actor.id,
      })
    } catch (error) {
      await this.#deps.state.releaseKeyMint(actor.id, scope)
      throw error
    }

    const key: StoredKey = {
      keyId: created.key.id,
      secret: created.secret,
      mintedAt: this.#deps.now(),
    }
    // Stored BEFORE the client is handed out: the secret came back exactly once, so losing it
    // between here and the caller would leave a live credential nobody can revoke.
    await this.#deps.state.commitKeyMint(actor.id, scope, key)
    return { client: this.#deps.clientFor(key.secret), keyId: key.keyId }
  }
}

function keyLabel(actor: Actor, scope: PublicApiScope): string {
  return `gatekeeper ${scope}: ${actor.label ?? actor.id}`.slice(0, MAX_LABEL_LENGTH)
}
