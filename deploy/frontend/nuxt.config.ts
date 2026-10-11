// Frontend deployment — a thin Nuxt app that consumes the @cat-factory/app layer.
//
// All the SPA logic (components, stores, composables, pages) lives in the layer;
// this app only `extends` it and applies per-deployment overrides. The backend
// URL is NOT set here: the SPA is `ssr: false`, so it is baked in at BUILD time
// from NUXT_PUBLIC_API_BASE (see README). `ssr`, modules, css and the runtime
// `apiBase` default are inherited from the layer.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const layerAppDir = join(
  dirname(createRequire(import.meta.url).resolve('@cat-factory/app/package.json')),
  'app',
)

export default defineNuxtConfig({
  extends: ['@cat-factory/app'],

  // Let Vite's dependency scan crawl the layer's own code. Nuxt adds a layer's files as
  // scan entries only when the layer lives in `node_modules`, which is true for an npm
  // install but not for this monorepo, where pnpm links the layer to `frontend/app`.
  // Without these entries the scan finds none of the layer's dependencies, so `nuxt dev`
  // discovers them while the first page loads and reloads the page after each batch.
  vite: layerAppDir.includes('/node_modules/')
    ? {}
    : {
        optimizeDeps: {
          entries: [
            join(layerAppDir, '**/*.{vue,ts}'),
            `!${join(layerAppDir, '**/*.{spec,test}.ts')}`,
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
