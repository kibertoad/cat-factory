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

import { CatFactoryClient } from '@cat-factory/sdk'
import type { PublicApiScope } from '@cat-factory/gatekeeper-bindings'
import type { GatekeeperState, StoredKey } from './state'

/** Who the OS says is calling. The Gatekeeper trusts this and NOTHING else the caller sends. */
export interface Actor {
  /** The OS's own identity for the person. Rides `externalIdentity` onto every minted key. */
  id: string
  /** Optional display name, used only to label the key for a human reading the key list. */
  label?: string
}

/** The label cap the key contract enforces. */
const MAX_LABEL_LENGTH = 120

export interface KeyBrokerDependencies {
  /** The paired workspace's durable state, holding minted keys. */
  state: DurableObjectStub<GatekeeperState>
  /** A client on the Gatekeeper's own `admin` provisioning key. */
  provisioning: CatFactoryClient
  /** Build a client on a minted key. */
  clientFor: (apiKey: string) => CatFactoryClient
  now: () => number
}

export class KeyBroker {
  readonly #deps: KeyBrokerDependencies

  constructor(deps: KeyBrokerDependencies) {
    this.#deps = deps
  }

  /**
   * A client authenticated as `actor`, at `scope`.
   *
   * The scope is the TIER's, never the caller's request: a caller asking for a better key is
   * asking the wrong side of the boundary.
   */
  async clientFor(actor: Actor, scope: PublicApiScope): Promise<CatFactoryClient> {
    const stored = await this.#deps.state.getKey(actor.id, scope)
    if (stored !== null) return this.#deps.clientFor(stored.secret)

    const created = await this.#deps.provisioning.keys.create({
      label: keyLabel(actor, scope),
      scope: scope as 'read' | 'write' | 'decide',
      externalIdentity: actor.id,
    })
    const key: StoredKey = {
      keyId: created.key.id,
      secret: created.secret,
      mintedAt: this.#deps.now(),
    }
    await this.#deps.state.putKey(actor.id, scope, key)
    return this.#deps.clientFor(key.secret)
  }

  /**
   * Revoke every key minted for an actor, for when the OS says they are gone.
   *
   * Revoked UPSTREAM FIRST, then forgotten. The other order can leave a live cat-factory key that
   * this Gatekeeper no longer knows exists, which is a credential nobody can find to revoke; this
   * order can at worst re-revoke an id, which the platform documents as idempotent.
   */
  async revoke(actor: Actor, scopes: readonly PublicApiScope[]): Promise<string[]> {
    const revoked: string[] = []
    for (const scope of scopes) {
      const stored = await this.#deps.state.getKey(actor.id, scope)
      if (stored === null) continue
      await this.#deps.provisioning.keys.revoke(stored.keyId)
      revoked.push(stored.keyId)
    }
    await this.#deps.state.forgetKeys(actor.id)
    return revoked
  }
}

function keyLabel(actor: Actor, scope: PublicApiScope): string {
  return `gatekeeper ${scope}: ${actor.label ?? actor.id}`.slice(0, MAX_LABEL_LENGTH)
}
