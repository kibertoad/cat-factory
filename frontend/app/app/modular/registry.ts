import { defineModule } from '@modular-vue/core'
import type { AnyModuleDescriptor } from '@modular-vue/core'
import { createRegistry } from '@modular-vue/runtime'
import type { ModuleRegistry } from '@modular-vue/runtime'

/**
 * modular-vue registry for the `@cat-factory/app` layer (slice 0 of the
 * modular-vue adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * This is the frontend analogue of the backend's public registries
 * (`registerAgentKind`, `registerGate`): a single registry into which the layer
 * registers its own first-party feature modules AND a consumer deployment
 * contributes its own, all through the same seam. The registry is resolved and
 * installed by `app/plugins/modular.client.ts`.
 *
 * Slice 0 wires the plumbing behind ZERO behaviour change: the one first-party
 * module carries no navigation / slots / component, so nothing new renders.
 * Later slices convert real areas (navigation, result views, wizards, inspector
 * panels) into modules registered here.
 */

/**
 * First-party modules the layer always registers. Kept tiny on purpose for
 * slice 0 — a single descriptor with no contributions, present only to prove the
 * registration pipeline end to end and give the seam a stable anchor. Real
 * feature modules land here as later slices convert each area.
 */
const FIRST_PARTY_MODULES: readonly AnyModuleDescriptor[] = [
  defineModule({ id: 'cat-factory:core', version: '1.0.0' }),
]

/**
 * Consumer-contributed modules, collected before the layer resolves its
 * registry. A deployment extending `@cat-factory/app` calls
 * {@link registerAppModule} from its own Nuxt plugin (which runs before the
 * layer's install plugin — see the ordering note in
 * `app/plugins/modular.client.ts`). Module descriptors carry Vue components, so
 * they can't travel through serializable Nuxt config; this in-process seam is
 * how the layer stays unforked while a consumer contributes real components.
 */
const consumerModules: AnyModuleDescriptor[] = []

/**
 * Contribute a module to the app registry from a consumer deployment (or a
 * first-party plugin). Call this at plugin-setup time, before the layer's
 * install plugin resolves the registry. Registering the same id twice makes
 * `resolve()` throw at build time (duplicate-id validation), which is the
 * intended guard.
 */
export function registerAppModule(module: AnyModuleDescriptor): void {
  consumerModules.push(module)
}

/**
 * Test-only: drop every consumer-registered module so a spec can exercise
 * {@link registerAppModule} without leaking state into the next test. Not part
 * of the runtime seam.
 */
export function __resetConsumerModulesForTest(): void {
  consumerModules.length = 0
}

/**
 * Build a fresh registry with the first-party modules plus everything a consumer
 * contributed via {@link registerAppModule}. A new registry per call because
 * `resolve()` / `resolveManifest()` are single-commit; the install plugin calls
 * this exactly once at client startup (`ssr: false`, so a singleton app).
 */
export function createAppRegistry(): ModuleRegistry<Record<string, unknown>> {
  const registry = createRegistry<Record<string, unknown>>({})
  for (const mod of [...FIRST_PARTY_MODULES, ...consumerModules]) {
    registry.register(mod)
  }
  return registry
}
