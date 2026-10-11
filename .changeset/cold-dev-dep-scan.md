---
'@cat-factory/app': patch
---

The layer's `nuxt` peer range now excludes 4.6.0, so a cold `nuxt dev` pre-bundles the SPA's
dependencies and the first page load no longer reloads.

Nuxt 4.6.0 broke Vite's dependency scan in any app that uses `@nuxtjs/i18n` (nuxt/nuxt#36473), so
`nuxt dev` found every dependency while the page loaded and reloaded the page after each batch. The
peer range is now `^4.5.2 <4.6.0 || ^4.6.1`: a deployment locked to 4.6.0 gets a peer warning and
must upgrade `nuxt` to 4.6.1 or later. A deployment that links the layer from a workspace, not from
`node_modules`, must also list the layer's files in `vite.optimizeDeps.entries`, because Nuxt adds
them only for an installed layer. The in-repo frontend deployment (`deploy/frontend/nuxt.config.ts`)
shows how.
