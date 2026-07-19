import { installModularApp } from '@modular-vue/nuxt/runtime'
import type { ApplicationManifest } from '@modular-vue/runtime'
import type { NavigationItem } from '@modular-frontend/core'
import { resolveComponentRegistry } from '@modular-vue/core'
import { provideJourneyRuntime } from '@modular-vue/journeys'
import type { JourneyRuntime } from '@modular-vue/journeys'
import { createAppRegistry } from '~/modular/registry'
import { navSlotFilter } from '~/modular/nav-contributions'
import { createNavGates } from '~/modular/nav-gates'
import { resultViewsModule } from '~/modular/result-views'
import {
  environmentSetupJourney,
  environmentSetupModule,
  environmentSetupPersistence,
} from '~/modular/journeys/environmentSetup'
import type { AppSlots, ResultViewContribution } from '~/modular/slots'
import type { CustomAgentKind } from '~/types/domain'

/**
 * Wire the modular-vue registry into the Nuxt app (slice 0 of the modular-vue
 * adoption — docs/initiatives/modular-vue-adoption.md).
 *
 * `enforce: 'post'` is load-bearing for the consumer-contribution seam. Nuxt
 * loads layer plugins before the consuming app's plugins within the same enforce
 * bucket, so a consumer that calls `registerAppModule(...)` from a normal plugin
 * would otherwise run AFTER this one and miss the resolve. Putting this plugin in
 * the `post` bucket flips the order: the consumer's default-bucket registration
 * runs first, then this resolves the registry with everything registered. A
 * consumer therefore contributes from a default (or `pre`) plugin — documented
 * in the framework-mode-nuxt guide upstream.
 *
 * `ssr: false`, so this runs once on the client and a singleton registry is
 * fine. `installModularApp` is the router-owning path: it grafts each module's
 * routes onto Nuxt's router (none yet — the nav modules are non-routed) and
 * installs the modular contexts (shared deps, navigation, slots) app-wide.
 *
 * Slice 1 wires the reactive nav gating here: `createNavGates()` builds the
 * reactive `gates` service (Pinia + composables are available in a `post`
 * plugin), which the registry registers as a `service` and `navSlotFilter` reads
 * per item. The shells consume the gated `nav` slot through `useReactiveSlots`,
 * so a permission/connection flip re-gates them with no `recalculateSlots()`.
 *
 * Slice 2 registers the first-party `resultViews` registry here (via
 * `extraModules`, so its Vue-component imports stay out of the unit-tested
 * `registry.ts` import graph), and feeds the resolved static `agentKinds` slot —
 * the deployment's CODE-shipped consumer agent kinds — into the agents store.
 * (Backend-registered kinds arrive later as the per-workspace capability
 * manifest via `hydrateCustomKinds`.) The result-view components themselves are
 * read reactively by `StepResultViewHost` through `useReactiveSlots`.
 */
export default defineNuxtPlugin({
  name: 'cat-factory:modular',
  enforce: 'post',
  setup(nuxtApp) {
    // Register the step-module carriers (they import `.vue`, so they enter via
    // `extraModules`, keeping the unit-tested `registry.ts` graph SFC-free) and the
    // journeys themselves (slice 3). `registerJourney` must run BEFORE the manifest
    // resolves (inside `installModularApp`).
    const registry = createAppRegistry({ gates: createNavGates() }, [
      resultViewsModule,
      environmentSetupModule,
    ])
    registry.registerJourney(environmentSetupJourney, {
      persistence: environmentSetupPersistence,
    })
    // The annotation is still required to break `defineNuxtPlugin`'s self-referential
    // return inference (the plugin provides `modular: manifest`, so an un-annotated
    // `manifest` resolves to `any` — TS7022). But since `@modular-vue/nuxt@0.3.0` now
    // FLOWS the registry's plugin-extension type through `installModularApp`, the
    // annotation can name the real `{ journeys: JourneyRuntime }` extension and TS
    // VERIFIES the `journeysPlugin` actually resolved it (pre-0.3.0 erased `TExtensions`
    // to `unknown`, so the extension had to be recovered with an unchecked
    // `as JourneyRuntime` cast). `manifest.journeys` / `manifest.slots` are now typed,
    // so the downstream casts are gone too.
    const manifest: ApplicationManifest<AppSlots, NavigationItem, { journeys: JourneyRuntime }> =
      installModularApp({ vueApp: nuxtApp.vueApp, $router: useRouter() }, registry, {
        slotFilter: navSlotFilter,
      })
    // Provide the resolved `JourneyRuntime` to the Vue app so `<JourneyProvider>` /
    // `<JourneyHost>` / `<JourneyOutlet>` resolve it from context (the wizard hosts
    // don't hand-thread a runtime).
    provideJourneyRuntime(nuxtApp.vueApp, manifest.journeys)
    const slots = manifest.slots
    // Fail FAST on a result-view wiring bug (a duplicate id across the first-party +
    // consumer `resultViews` modules) at BOOT rather than lazily the first time a result
    // window opens: resolve the merged slot once here. `resolveComponentRegistry` throws on
    // a duplicate id by default, so a misconfigured deployment surfaces at startup with a
    // clear stack. The slot is static after this resolve, so `StepResultViewHost`'s own
    // reactive re-resolve is a cheap memoized read that this has already validated.
    resolveComponentRegistry((slots.resultViews ?? []) as ResultViewContribution[])
    // Consumer agent kinds contributed as CODE to the static `agentKinds` slot
    // (module slots resolve once, so the static base is the full set).
    useAgentsStore().registerConsumerKinds((slots.agentKinds ?? []) as CustomAgentKind[])
    return { provide: { modular: manifest } }
  },
})
