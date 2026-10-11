// Frontend deployment — a thin Nuxt app that consumes the @cat-factory/app layer.
//
// All the SPA logic (components, stores, composables, pages) lives in the layer;
// this app only `extends` it and applies per-deployment overrides. The backend
// URL is NOT set here: the SPA is `ssr: false`, so it is baked in at BUILD time
// from NUXT_PUBLIC_API_BASE (see README). `ssr`, modules, css and the runtime
// `apiBase` default are inherited from the layer.
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// Forward slashes on every OS: Vite globs `optimizeDeps.entries`, and a glob reads a
// Windows backslash as an escape character, so a `node:path` path would match nothing.
const layerAppDir = `${dirname(
  createRequire(import.meta.url).resolve('@cat-factory/app/package.json'),
).replaceAll('\\', '/')}/app`

export default defineNuxtConfig({
  extends: ['@cat-factory/app'],

  // Let Vite's dependency scan crawl the layer's own code. Nuxt adds a layer's files as
  // scan entries only when the layer lives in `node_modules` (nuxt/nuxt#36208), which is
  // true for an npm install but not for this monorepo, where pnpm links the layer to
  // `frontend/app`. Without these entries the scan misses every dependency that only the
  // layer imports, so `nuxt dev` discovers them while the first page loads and reloads the
  // page after each batch. The first two globs are Nuxt's own (`installedScanEntries`);
  // the third is ours, so test-only imports (vitest, msw) are not pre-bundled. The scan
  // crawls every layer file, including ones the first page never imports, which costs a
  // fraction of a second per cold start and saves the reloads.
  vite: layerAppDir.includes('/node_modules/')
    ? {}
    : {
        optimizeDeps: {
          entries: [
            `${layerAppDir}/**/*.{vue,js,jsx,mjs,ts,tsx,mts}`,
            `!${layerAppDir}/**/node_modules/**`,
            `!${layerAppDir}/**/*.{spec,test}.{vue,js,jsx,mjs,ts,tsx,mts}`,
          ],
        },
      },

  // Per-deployment branding. Override the title/meta/favicon for your org here.
  app: {
    head: {
      title: 'Agent Architecture Board',
    },
  },
})
