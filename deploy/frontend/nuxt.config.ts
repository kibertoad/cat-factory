// Frontend deployment — a thin Nuxt app that consumes the @cat-factory/app layer.
//
// All the SPA logic (components, stores, composables, pages) lives in the layer;
// this app only `extends` it and applies per-deployment overrides. The backend
// URL is NOT set here: the SPA is `ssr: false`, so it is baked in at BUILD time
// from NUXT_PUBLIC_API_BASE (see README). `ssr`, modules, css and the runtime
// `apiBase` default are inherited from the layer.
export default defineNuxtConfig({
  extends: ['@cat-factory/app'],

  // Per-deployment branding. Override the title/meta/favicon for your org here.
  app: {
    head: {
      title: 'Agent Architecture Board',
    },
  },
})
