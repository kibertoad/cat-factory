import type { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import { binaryGeneratorRegistryWithBuiltins } from '@cat-factory/binary-generators'

// Installation-level extension point for the deployment's OWN GENERATIVE BINARY INTEGRATIONS: the
// image / music / video generation APIs a binary-generating step is pointed at.
//
// Registration is PROCESS-WIDE and read by every `buildContainer(env)` call, for the reason
// `binaryStores.ts` states about artifact stores and `toolSecretResolver.ts` about capability
// credentials: the Worker builds a container PER ENTRY POINT, and an instance carried only on
// `createApp` reaches the fetch path alone. A binary-output step's dispatch BRIEF (the integration
// views a step selected, plus their contract documents) is composed on the durable path, where
// `ExecutionWorkflow` builds its own `buildContainer(this.env)` per wake, so a registry threaded
// only through `createWorker` would be accepted at boot and then never asked for the integrations
// the dispatch needs.
//
// The failure that leaves is quiet and misattributed. The container-less fallback below is the
// SHIPPED set, so a run does not refuse: it dispatches with the platform's own integration in the
// brief and none of the deployment's, and a step selecting one of theirs meets
// `binary_output_generator_invalid` on a path nobody is watching rather than at boot.
//
// ONE SLOT holding one registry, last write wins, matching the store registry beside it: a step
// resolves its `generatorIds` against a single catalog, and two registrations would be two
// catalogs with no defined precedence between colliding ids.
//
// Unlike the store registry, this one HAS a platform default, which is the only difference between
// the two modules. An unregistered build answers the shipped integrations rather than an empty
// registry, because a facade that resolved nothing here would refuse the shipped `pl_media` preset
// on exactly the override-less paths.

let registered: BinaryGeneratorRegistry | undefined

/**
 * Register this installation's generative binary integrations for every container build in the
 * process.
 *
 * An injected registry REPLACES the shipped set rather than merging with it, here as everywhere
 * else. A deployment that wants both starts from `binaryGeneratorRegistryWithBuiltins()` and
 * registers onto that instance.
 */
export function registerBinaryGeneratorRegistry(registry: BinaryGeneratorRegistry): void {
  registered = registry
}

/**
 * The registered integrations, or a fresh registry carrying the SHIPPED set when a deployment
 * registered none.
 *
 * The shipped set rather than an empty registry, because emptiness means something different here
 * than it does for the stores: the platform ships `nano-banana` and the built-in `pl_media` preset
 * selects it by id, so an empty answer is not "this deployment registers no integrations" but a
 * refused run on the one preset that exercises the flow.
 */
export function registeredBinaryGeneratorRegistry(): BinaryGeneratorRegistry {
  return registered ?? binaryGeneratorRegistryWithBuiltins()
}

/** Drop the registration. Intended for tests that exercise registration. */
export function clearBinaryGeneratorRegistry(): void {
  registered = undefined
}
