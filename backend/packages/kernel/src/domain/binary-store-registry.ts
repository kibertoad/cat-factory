import type { BinaryBlobBackend } from '../ports/binary-artifacts.js'
import { BUILTIN_BINARY_ARTIFACT_STORAGE_KINDS } from '../ports/binary-artifacts.js'
import type { Logger } from '../ports/logging.js'

// App-owned registry of the BINARY ARTIFACT STORES a deployment ships in code — the places the
// bytes of a run's screenshots and a design's rendered frames physically live. It mirrors the
// agent-kind / gate / pipeline / foundational-service / generative-integration registries: the
// composition root news one instance (`defaultBinaryBlobBackendRegistry()`), a deployment
// registers its stores on it BY REFERENCE, and the per-account store resolver reads it back when
// an account selects one.
//
// The platform ships five stores (`fs`, `db`, `s3`, `r2`, `memory`), and until this registry
// existed those five were the whole world: a deployment on GCS, Azure Blob, IPFS or an internal
// object service had to fork the facade it was already depending on, because
// `BinaryBlobBackend` was implementable and unreachable — nothing between an implementation and
// the resolver's `switch`.
//
// WHY THIS ONE IS PER-PROCESS, where the generative-integration registry is not. That registry
// is DATA a run resolves (ids, content types, a credential's name), so a mothership-mode node
// reading its own copy is reading a build that can be one release behind the one the pipeline
// builder offered from, and the set therefore crosses `/internal/binary-generators`. A store is
// the opposite kind of thing: it is an in-process CAPABILITY, a live object holding a client and
// credentials, and only the process about to write the bytes can construct one. So the process
// that ANSWERS the settings picker is by construction the process that STORES, on a mothership
// node exactly as on a standalone one, and there is nothing here for a machine API to carry.
// It is the same reason `providerRegistry` is facade-internal rather than transported.

/** What the resolver tells a store about the account it is being built for. */
export interface BinaryStoreContext {
  /**
   * The account whose artifacts this store will hold, or null for a legacy unscoped board.
   *
   * Supplied so a multi-tenant deployment can shard by account (a bucket or key prefix per
   * account) without a per-account settings surface. A store that ignores it holds every
   * account's bytes together, which is the right shape for a single-tenant deployment and is why
   * this is context rather than a required parameter.
   */
  accountId: string | null
  /** The composition root's logger, for a store that wants to report its own diagnostics. */
  logger?: Logger
}

/**
 * A binary artifact store a DEPLOYMENT defines in code: identity for the account-settings picker,
 * plus the factory that builds the {@link BinaryBlobBackend} the composed store writes through.
 */
export interface BinaryStoreDefinition {
  /**
   * Stable id. It is what an account's content-storage config names, and what is stamped onto
   * each artifact row's `storage` column, so it must be stable across releases: changing it
   * orphans the rows already pointing at it (the bytes stay where they are, but nothing left
   * says which store to ask for them).
   *
   * Lowercase letters, digits and dashes, and never one of the platform's own kinds — see
   * {@link BinaryStoreRegistrationError}.
   */
  id: string
  /** Human-readable name, shown in the account-settings storage picker. */
  name: string
  /** One line of what it is and where the bytes go, shown beside the name. */
  summary?: string
  /**
   * Build the backend for one account. Called on a cache miss (the resolver memoises the composed
   * store per account), so a client built here survives across requests.
   *
   * Return `null` for "this deployment cannot serve the store right now" (an unset credential, an
   * un-provisioned bucket): the resolver treats it exactly as it treats an unsupported built-in
   * backend, so storage reads as unavailable rather than half-working, and says so in the log.
   * Throwing is for a programming error, and propagates.
   *
   * The returned backend's own `kind` is not used: the resolver stamps {@link id} onto the
   * artifact rows, because one implementation registered twice (a bucket per region, say) would
   * otherwise file both registrations' rows under one name.
   */
  create(context: BinaryStoreContext): BinaryBlobBackend | null
}

/** What the picker and the boot report show about a registered store — never the backend itself. */
export interface BinaryStoreView {
  id: string
  name: string
  summary?: string
}

/**
 * A registration this platform refuses. Thrown at REGISTRATION rather than collected as a
 * warning, because a store is composition code: the deployment is holding the registry when it
 * happens, and the alternative (a store registered under an id the resolver can never select) is
 * an account settings picker offering an entry that silently resolves to no storage at all.
 */
export class BinaryStoreRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryStoreRegistrationError'
  }
}

/** Ids are compared and persisted as-is, so the shape is constrained rather than normalised. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * App-owned registry of the deployment's own binary artifact stores. The composition root news
 * ONE instance and a deployment registers its stores on it by reference; the per-account resolver
 * builds a backend from it whenever an account has selected one.
 */
export class BinaryStoreRegistry {
  private readonly definitions = new Map<string, BinaryStoreDefinition>()

  /**
   * Register a store. A registration whose id matches an earlier one replaces it (the same
   * last-wins rule every other app-owned registry uses, so a deployment can override a store its
   * own shared composition module registered).
   *
   * Refuses an id the resolver could not honour: a malformed one, or one of the platform's own
   * backend kinds. The second is the load-bearing check — `s3` and `fs` are selected through
   * their own config (a bucket, a base path, sealed credentials), so a store registered under
   * one of those names would be picked in the UI and never built, with the account looking
   * correctly configured throughout.
   */
  register(definition: BinaryStoreDefinition): void {
    const id = definition.id
    if (!ID_PATTERN.test(id)) {
      throw new BinaryStoreRegistrationError(
        `binary store id ${JSON.stringify(id)} is not usable: use lowercase letters, digits and ` +
          `dashes (max 63 characters). The id is persisted on every artifact row, so it is ` +
          `constrained rather than normalised.`,
      )
    }
    if ((BUILTIN_BINARY_ARTIFACT_STORAGE_KINDS as readonly string[]).includes(id)) {
      throw new BinaryStoreRegistrationError(
        `binary store id ${JSON.stringify(id)} is one of the platform's own backend kinds ` +
          `(${BUILTIN_BINARY_ARTIFACT_STORAGE_KINDS.join(', ')}). Those are selected through their ` +
          `own account config, so a store registered under one would be offered in the settings ` +
          `picker and never built. Pick another id.`,
      )
    }
    this.definitions.set(id, definition)
  }

  /** Register several stores at once. */
  registerAll(definitions: Iterable<BinaryStoreDefinition>): void {
    for (const definition of definitions) this.register(definition)
  }

  /** The registered definition for an id, or undefined when this build registers none. */
  get(id: string): BinaryStoreDefinition | undefined {
    return this.definitions.get(id)
  }

  /** Every registered id, in registration order. */
  ids(): string[] {
    return [...this.definitions.keys()]
  }

  /** How many stores are registered — the "does this deployment offer any" check. */
  get size(): number {
    return this.definitions.size
  }

  /** The picker-facing projection: identity only, never the factory. */
  views(): BinaryStoreView[] {
    return [...this.definitions.values()].map((definition) => ({
      id: definition.id,
      name: definition.name,
      ...(definition.summary ? { summary: definition.summary } : {}),
    }))
  }
}

/** A fresh, EMPTY registry — the platform registers no custom stores of its own. */
export function defaultBinaryStoreRegistry(): BinaryStoreRegistry {
  return new BinaryStoreRegistry()
}
