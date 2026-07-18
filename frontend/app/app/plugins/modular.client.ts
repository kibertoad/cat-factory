import { installModularApp } from '@modular-vue/nuxt/runtime'
import { createAppRegistry } from '~/modular/registry'

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
 * routes onto Nuxt's router (none yet — slice 0 modules are non-routed) and
 * installs the modular contexts (shared deps, navigation, slots) app-wide. The
 * resolved manifest is exposed as `$modular` for later slices; nothing reads it
 * yet, which is what keeps this behaviour-neutral.
 */
export default defineNuxtPlugin({
  name: 'cat-factory:modular',
  enforce: 'post',
  setup(nuxtApp) {
    const registry = createAppRegistry()
    const manifest = installModularApp({ vueApp: nuxtApp.vueApp, $router: useRouter() }, registry)
    return { provide: { modular: manifest } }
  },
})
