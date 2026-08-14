import type { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import { defaultBinaryGeneratorRegistry } from '@cat-factory/kernel'
import type { BinaryGeneratorEntry } from './define.js'
import { nanoBananaGenerator } from './generators/nano-banana.js'

// ---------------------------------------------------------------------------
// The built-in generative binary integrations, authored ENTIRELY through the public
// binary-generator seam: this package depends on @cat-factory/kernel + @cat-factory/contracts and
// never on the engine. It is the same dogfood `@cat-factory/gates` and
// `@cat-factory/prompt-fragments` are: if the platform's own image integration can be expressed as
// an external package, so can a deployment's, and the seam cannot rot for consumers only because
// every boot exercises it.
//
// The registry itself stays EMPTY by default (`defaultBinaryGeneratorRegistry()`). A facade
// chooses: `binaryGeneratorRegistryWithBuiltins()` is what the shipped runtimes default to, and a
// deployment that wants a different set news its own instance. The two are opposite deployments
// and both are legitimate, which is why neither is baked into the registry class.
//
// WHY THE PLATFORM SHIPS ONE AT ALL. The registry shipped empty on the argument that no image
// generator is one every organisation runs and that every one of them is metered. Both halves
// are still true. What changed is that the Media task type shipped a generating agent, a preset
// and the storage under it, and left the selection blank: the platform's most demonstrable
// capability was the one nothing shipped could exercise, and closing that gap took a deployment
// writing an integration, an OpenAPI document and a credential declaration first. Metered is
// answered by the credential rather than by the registry: with no key resolved the agent is told
// the integration is unavailable and reports it as the reason an artifact is missing, so a
// deployment that ignores this entry pays nothing and sees one extra row in a picker.
// ---------------------------------------------------------------------------

export {
  type BinaryGeneratorEntry,
  type BinaryGeneratorInput,
  defineBinaryGenerator,
  openApiContract,
} from './define.js'
export {
  NANO_BANANA_CREDENTIAL_KEY,
  NANO_BANANA_GENERATOR_ID,
  nanoBananaGenerator,
} from './generators/nano-banana.js'
export { NANO_BANANA_OPENAPI } from './contracts/nano-banana.openapi.js'

/**
 * The integrations the platform ships, in registration order.
 *
 * Exported as data so a deployment can register a SUBSET (or none) onto its own registry instance
 * without reaching into this package's internals, and so a test can assert over the shipped set
 * rather than over whatever a helper happened to install.
 */
export const BUILTIN_BINARY_GENERATORS: readonly BinaryGeneratorEntry[] = [nanoBananaGenerator]

/**
 * Install the built-in integrations onto an app-owned registry instance, and return it.
 *
 * Idempotent by id: registering twice replaces rather than duplicates, so an entry point a test
 * also drives is safe to call again. Registration ORDER is what makes a deployment's own
 * definition of a shipped id an override, so the built-ins go first.
 */
export function registerBuiltinBinaryGenerators(
  registry: BinaryGeneratorRegistry,
  generators: readonly BinaryGeneratorEntry[] = BUILTIN_BINARY_GENERATORS,
): BinaryGeneratorRegistry {
  registry.registerAll(generators)
  return registry
}

/**
 * A fresh {@link BinaryGeneratorRegistry} carrying the shipped integrations.
 *
 * What each facade defaults to when a deployment injects no registry of its own, exactly as
 * `gateRegistryWithBuiltins()` and `promptFragmentRegistryWithBuiltins()` are. An INJECTED registry
 * replaces this one rather than merging with it, so a deployment that wants its own integrations
 * AND the shipped ones starts from this call and registers onto the same instance:
 *
 *     const binaryGeneratorRegistry = binaryGeneratorRegistryWithBuiltins()
 *     binaryGeneratorRegistry.registerAll(myIntegrations)
 *     startLocal({ binaryGeneratorRegistry })
 *
 * That matters more here than for the other two registries, because the shipped `pl_media` preset
 * SELECTS `nano-banana` by id: a registry without it refuses that pipeline's runs at admission
 * (`binary_output_generator_invalid`) rather than degrading, which is the correct disposition for
 * a step naming an integration nobody registered and a loud one to meet on upgrade.
 *
 * Registered ONCE per deployment, on the process that owns the registry. In mothership mode that
 * is the mothership: a node resolves integrations over `/internal/binary-generators` and consults
 * no registry of its own, so the set the pipeline builder offers and the set admission resolves
 * are one set however far behind the node's build has drifted.
 */
export function binaryGeneratorRegistryWithBuiltins(): BinaryGeneratorRegistry {
  return registerBuiltinBinaryGenerators(defaultBinaryGeneratorRegistry())
}
