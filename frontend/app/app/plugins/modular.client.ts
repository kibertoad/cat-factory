import { installModularApp } from '@modular-vue/nuxt/runtime'
import { createAppRegistry } from '~/modular/registry'
import { navSlotFilter } from '~/modular/nav-contributions'
import { createNavGates } from '~/modular/nav-gates'

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
 */
export default defineNuxtPlugin({
  name: 'cat-factory:modular',
  enforce: 'post',
  setup(nuxtApp) {
    const registry = createAppRegistry({ gates: createNavGates() })
    const manifest = installModularApp({ vueApp: nuxtApp.vueApp, $router: useRouter() }, registry, {
      slotFilter: navSlotFilter,
    })
    return { provide: { modular: manifest } }
  },
})
