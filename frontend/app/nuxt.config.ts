// https://nuxt.com/docs/api/configuration/nuxt-config
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This is a Nuxt *layer*: a consuming app `extends` it. Config file paths must
// resolve against THIS layer's directory, not the consumer's — `~`/`@` rebind to
// the consumer's srcDir, so an asset referenced as `~/assets/...` would be looked
// up in the consumer. Use an absolute path anchored here instead.
const layerDir = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-06-01',
  devtools: { enabled: true },

  // Render as a pure client-side SPA that talks to the cat-factory backend.
  ssr: false,

  // The board is a single dark-themed surface (neutral is mapped to `slate` and
  // every component is hand-styled in slate). Pin Nuxt UI's color mode to dark so
  // its own chrome (modals, inputs, selects, dropdowns) matches instead of
  // following the visitor's system preference and rendering light/white overlays.
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },

  runtimeConfig: {
    public: {
      // Base URL of the cat-factory worker API. Defaults to the local wrangler
      // dev server; override per-environment with NUXT_PUBLIC_API_BASE.
      apiBase: 'http://localhost:8787',
    },
  },

  modules: ['@nuxt/ui', '@pinia/nuxt', 'pinia-plugin-persistedstate/nuxt'],

  // This is a Nuxt *layer*. @pinia/nuxt's default `storesDirs` is an ABSOLUTE path
  // resolved against the CONSUMER's srcDir, so when this layer is `extends`ed it
  // resolves every layer to the consumer's (empty) `stores/` and never scans this
  // layer's own stores — every `use*Store` then fails as "not defined" at boot. A
  // RELATIVE entry is re-resolved against each layer's app dir
  // (`resolve(layer.app, 'stores')`), so the layer's stores auto-import in any
  // consumer (and a consumer can still add its own `stores/`). See @pinia/nuxt
  // module.mjs.
  pinia: {
    storesDirs: ['stores'],
  },

  css: [
    '@vue-flow/core/dist/style.css',
    '@vue-flow/core/dist/theme-default.css',
    '@vue-flow/minimap/dist/style.css',
    '@vue-flow/node-resizer/dist/style.css',
    join(layerDir, 'app/assets/css/main.css'),
  ],

  app: {
    head: {
      title: 'Agent Architecture Board',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  vite: {
    // Pre-bundle the SPA's heavy dependencies at dev-server startup. Since ~25 panels in
    // `pages/index.vue` are `defineAsyncComponent(() => import(...))`, Vite's startup dep
    // scan (which follows static imports only) no longer crawls into them, so these deps
    // would otherwise be discovered at runtime — each discovery triggers a dep
    // re-optimization that forces a full page reload. In the Playwright e2e run (which
    // drives `nuxt dev`) such a mid-test reload aborts an in-flight `page.goto` with
    // `net::ERR_ABORTED`, hanging a spec to its 180s timeout. Pinning the list (the exact
    // set the dev server reports discovering) keeps dev/e2e deterministic without giving
    // back the production code-splitting win.
    optimizeDeps: {
      include: [
        'wretch',
        'valibot',
        '@toad-contracts/frontend-http-client',
        '@toad-contracts/valibot',
        '@vue-flow/core',
        '@vue-flow/background',
        '@vue-flow/minimap',
        '@vueuse/core',
        'markdown-it',
      ],
    },
  },
})
