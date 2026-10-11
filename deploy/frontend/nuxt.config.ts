// Frontend deployment — a thin Nuxt app that consumes the @cat-factory/app layer.
//
// All the SPA logic (components, stores, composables, pages) lives in the layer;
// this app only `extends` it and applies per-deployment overrides. The backend
// URL is NOT set here: the SPA is `ssr: false`, so it is baked in at BUILD time
// from NUXT_PUBLIC_API_BASE (see README). `ssr`, modules, css and the runtime
// `apiBase` default are inherited from the layer.
import { getLayerDirectories } from 'nuxt/kit'
import { convertPathToPattern } from 'tinyglobby'

const SCANNED = '{vue,js,jsx,mjs,ts,tsx,mts}'

export default defineNuxtConfig({
  extends: ['@cat-factory/app'],

  modules: [
    // Let Vite's dependency scan crawl every linked layer's own code. Nuxt adds a layer's
    // files as scan entries only when the layer lives in `node_modules` (nuxt/nuxt#36208,
    // `installedScanEntries`), which is true for an npm install but not for this monorepo,
    // where pnpm links `@cat-factory/app` from `frontend/app`. Without these entries the
    // scan misses every dependency that only the layer imports, so `nuxt dev` discovers
    // them while the first page loads and reloads the page after each batch.
    //
    // This applies Nuxt's rule to the layers it skips: the same layer directories, the same
    // include glob and `node_modules` exclusion, plus a third glob of ours so test-only
    // imports (vitest, msw) are not pre-bundled. `convertPathToPattern` turns a Windows path
    // into forward slashes and escapes glob characters in the checkout path. The scan
    // crawls every layer file, including ones the first page never imports, which costs a
    // fraction of a second per cold start and saves the reloads.
    (_options, nuxt) => {
      // The first layer is this app's own; Nuxt's rule skips it too.
      const [own, ...layers] = getLayerDirectories(nuxt)
      const entries = layers
        .filter(({ app }) => app !== own?.app && !app.includes('/node_modules/'))
        .flatMap(({ app }) => {
          const dir = convertPathToPattern(app)
          return [
            `${dir}**/*.${SCANNED}`,
            `!${dir}**/node_modules/**`,
            `!${dir}**/*.{spec,test}.${SCANNED}`,
          ]
        })
      if (entries.length === 0) return
      const optimizeDeps = (nuxt.options.vite.optimizeDeps ||= {})
      optimizeDeps.entries = [...[optimizeDeps.entries ?? []].flat(), ...entries]
    },
  ],

  // Per-deployment branding. Override the title/meta/favicon for your org here.
  app: {
    head: {
      title: 'Agent Architecture Board',
    },
  },
})
