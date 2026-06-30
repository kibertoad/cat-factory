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

  modules: ['@nuxt/ui', '@pinia/nuxt', 'pinia-plugin-persistedstate/nuxt', '@nuxtjs/i18n'],

  // i18n lives in THIS layer's `i18n/` dir (the v9+ `restructureDir` convention).
  // @nuxtjs/i18n is layer-aware: it scans `i18n/locales/` in every layer of the
  // `extends` chain and DEEP-MERGES them (the consumer layer wins on key conflicts),
  // so a downstream deployment can override/add a locale by dropping its own
  // `i18n/locales/*.json` with no change here. Unlike the css block above, the paths
  // here MUST be bare filenames (not `layerDir`-anchored absolutes): the module
  // resolves `vueI18n`/`langDir` per-layer itself, and an absolute path would break
  // that per-layer resolution.
  i18n: {
    // Pure SPA (`ssr: false`): a single in-app locale, no URL-prefix routing.
    strategy: 'no_prefix',
    defaultLocale: 'en',
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json', name: 'English' },
      { code: 'es', language: 'es-ES', file: 'es.json', name: 'Español' },
      { code: 'pl', language: 'pl-PL', file: 'pl.json', name: 'Polski' },
      { code: 'uk', language: 'uk-UA', file: 'uk.json', name: 'Українська' },
      { code: 'fr', language: 'fr-FR', file: 'fr.json', name: 'Français' },
      { code: 'he', language: 'he-IL', file: 'he.json', name: 'עברית', dir: 'rtl' },
    ],
    vueI18n: 'i18n.config.ts',
    experimental: {
      // Generate types from the `en` messages so an unknown `$t`/`t` key is a `nuxt
      // typecheck` failure — the load-bearing maintainability guardrail given the repo
      // lints with oxlint only (no `@intlify/eslint-plugin-vue-i18n` `no-raw-text`).
      typedOptionsAndMessages: 'default',
    },
  },

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
    '@vue-flow/node-resizer/dist/style.css',
    join(layerDir, 'app/assets/css/main.css'),
  ],

  // Force Vite to pre-bundle `fast-querystring` (a CommonJS dep reached via
  // @toad-contracts/frontend-http-client). Left un-optimized, Vite serves its raw CJS
  // from @fs where cjs-module-lexer can't see the named `stringify` export (the module
  // uses a `module.exports = x; module.exports.stringify = …` reassignment), so the SPA
  // throws at runtime:
  //   SyntaxError: … fast-querystring/lib/index.js does not provide an export named 'stringify'
  // Pre-bundling makes esbuild emit an ESM wrapper with proper CJS interop.
  //
  // This config is resolved from the CONSUMER app's root (the deployment that `extends`
  // this layer), where — under pnpm's strict layout — only this layer (`@cat-factory/app`)
  // is hoisted; `frontend-http-client`/`fast-querystring` are not. So anchor the nested
  // `a > b > c` specifier at `@cat-factory/app` and let Vite resolve each hop from there.
  vite: {
    optimizeDeps: {
      include: ['@cat-factory/app > @toad-contracts/frontend-http-client > fast-querystring'],
    },
  },

  app: {
    head: {
      title: 'Agent Architecture Board',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})
