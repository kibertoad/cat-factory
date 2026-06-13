// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-06-01',
  devtools: { enabled: true },

  // Render as a pure client-side SPA that talks to the cat-factory backend.
  ssr: false,

  runtimeConfig: {
    public: {
      // Base URL of the cat-factory worker API. Defaults to the local wrangler
      // dev server; override per-environment with NUXT_PUBLIC_API_BASE.
      apiBase: 'http://localhost:8787',
    },
  },

  modules: ['@nuxt/ui', '@pinia/nuxt', 'pinia-plugin-persistedstate/nuxt'],

  css: [
    '@vue-flow/core/dist/style.css',
    '@vue-flow/core/dist/theme-default.css',
    '@vue-flow/controls/dist/style.css',
    '@vue-flow/minimap/dist/style.css',
    '@vue-flow/node-resizer/dist/style.css',
    '~/assets/css/main.css',
  ],

  app: {
    head: {
      title: 'Agent Architecture Board',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})
