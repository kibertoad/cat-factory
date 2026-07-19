import type { AnyModuleDescriptor } from '@modular-vue/core'
import { createRegistry } from '@modular-vue/runtime'
import { journeysPlugin } from '@modular-vue/journeys'
import { navigationModule } from '~/modular/nav-contributions'
import type { NavGates } from '~/modular/nav-contributions'
import type { AppSlots } from '~/modular/slots'

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
 * Slice 1 registers the first real feature module: `cat-factory:navigation`
 * contributes the whole nav/command catalog to the `nav` slot, gated reactively
 * by a `gates` service + `navSlotFilter` and rendered by `SideBar`, `CommandBar`,
 * and `BoardToolbar` via `useReactiveSlots`. Later slices add result views,
 * wizards, and inspector panels as further modules registered here.
 */

/**
 * The layer's shared-dependency shape (grows as later slices wire more deps).
 * A `type` (not `interface`) so it satisfies the registry's
 * `Record<string, any>` dependency constraint — an interface lacks the implicit
 * index signature a type-literal has.
 */
export type AppDeps = {
  /** Reactive RBAC/availability gates the nav `slotFilter` reads. */
  gates: NavGates
}

/**
 * First-party modules the layer always registers. Real feature modules land
 * here as each area is converted; slice 1 adds the navigation catalog.
 */
const FIRST_PARTY_MODULES: readonly AnyModuleDescriptor[] = [navigationModule]

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
 * Build a fresh registry with the first-party modules, any `extraModules` the
 * caller supplies, plus everything a consumer contributed via
 * {@link registerAppModule}. A new registry per call because `resolve()` /
 * `resolveManifest()` are single-commit; the install plugin calls this exactly
 * once at client startup (`ssr: false`, so a singleton app).
 *
 * `deps.gates` is the reactive gate service the nav `slotFilter` reads; it's
 * built in the install plugin (Vue context) and registered as a `service` so
 * `useReactiveSlots` tracks it. Each slot default is seeded empty so the key
 * always exists even before any module (or with only consumer modules)
 * contributes to it.
 *
 * `extraModules` is how the client plugin registers first-party modules that
 * carry Vue components (the `resultViews` registry): keeping them out of
 * `FIRST_PARTY_MODULES` keeps this module's static import graph — which the
 * unit tests exercise — free of `.vue` files (the vitest config has no SFC
 * transform).
 */
export function createAppRegistry(
  deps: AppDeps,
  extraModules: readonly AnyModuleDescriptor[] = [],
) {
  // `.use(journeysPlugin())` attaches the journeys extension (slice 3): the returned
  // registry gains `registerJourney(...)` and the resolved manifest exposes the
  // `JourneyRuntime` at `extensions.journeys`, which the client plugin provides to the
  // Vue app. The plugin itself carries no `.vue` imports, so it's safe in this
  // unit-tested import graph; the journeys + their step modules (which DO import SFCs)
  // are registered from the client plugin via `extraModules` + `registerJourney`.
  const registry = createRegistry<AppDeps, AppSlots>({
    services: { gates: deps.gates },
    slots: { nav: [], resultViews: [], agentKinds: [] },
  }).use(journeysPlugin())
  for (const mod of [...FIRST_PARTY_MODULES, ...extraModules, ...consumerModules]) {
    registry.register(mod)
  }
  return registry
}
