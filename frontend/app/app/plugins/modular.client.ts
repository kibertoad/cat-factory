import { installModularApp } from '@modular-vue/nuxt/runtime'
import { resolveComponentRegistry } from '@modular-vue/core'
import { createAppRegistry } from '~/modular/registry'
import { navSlotFilter } from '~/modular/nav-contributions'
import { createNavGates } from '~/modular/nav-gates'
import { resultViewsModule } from '~/modular/result-views'
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
    const registry = createAppRegistry({ gates: createNavGates() }, [resultViewsModule])
    const manifest = installModularApp({ vueApp: nuxtApp.vueApp, $router: useRouter() }, registry, {
      slotFilter: navSlotFilter,
    })
    const slots = manifest.slots as AppSlots
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
