import { type BinaryStoreRegistry, defaultBinaryStoreRegistry } from '@cat-factory/kernel'

// Installation-level extension point for the deployment's OWN BINARY ARTIFACT STORES: the
// `BinaryBlobBackend` implementations an account can select as its content-storage backend.
//
// Registration is PROCESS-WIDE and read by every `buildContainer(env)` call, for the reason
// `toolSecretResolver.ts` states about capability credentials and `ai/registries.ts` about model
// providers: the Worker builds a container PER ENTRY POINT, and an instance carried only on
// `createApp` reaches the fetch path alone. Artifacts are written from the durable driver
// (`ExecutionWorkflow` builds its own `buildContainer(this.env)` per wake, and the
// visual-confirmation gate stores its screenshots from there), so a registry threaded only
// through `createWorker` would be accepted and then never asked for the store the gate needs.
// The gate's disposition for "no store" is to PASS THROUGH, so the symptom is not an error: the
// run just completes with nothing captured.
//
// This is also the seam the RETENTION cron reads. That sweep builds its per-account store
// resolver outside the container entirely, so it is furthest of all from where the stores are
// registered, and a sweep that cannot build an account's store reclaims nothing for it: bytes
// kept forever, metadata rows with them.
//
// ONE SLOT holding one registry, last write wins, where model registries are a LIST: an account
// selects a store by id off a single catalog, and two registrations would be two catalogs with
// no defined precedence between colliding ids.
//
// Unlike the model registries and the credential resolver this holds the INSTANCE rather than a
// factory over `env`. A store is constructed by the deployment's own code, which is the only
// party that knows what it needs; a `BinaryStoreDefinition.create` receives the account it is
// being built for at resolve time, so nothing here has to wait for a binding to exist.

let registered: BinaryStoreRegistry | undefined

/** Register this installation's binary artifact stores for every container build in the process. */
export function registerBinaryStoreRegistry(registry: BinaryStoreRegistry): void {
  registered = registry
}

/**
 * The registered stores, or a fresh EMPTY registry when a deployment registered none.
 *
 * Empty rather than undefined because every reader wants the same thing: a catalog to look an
 * account's `storeId` up in, whose emptiness is exactly the answer "this build registers no
 * stores". The settings picker offers `custom` only when the catalog has entries, and the
 * resolver names the (empty) registered set when an account points at an id nothing serves.
 */
export function registeredBinaryStoreRegistry(): BinaryStoreRegistry {
  return registered ?? defaultBinaryStoreRegistry()
}

/** Drop the registration. Intended for tests that exercise registration. */
export function clearBinaryStoreRegistry(): void {
  registered = undefined
}
