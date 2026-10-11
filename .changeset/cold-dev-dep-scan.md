---
'@cat-factory/app': patch
---

Upgrade `nuxt` to 4.6.1 or later so a cold `nuxt dev` pre-bundles the SPA's dependencies and the
first page load no longer reloads. The layer's `nuxt` peer range is now `^4.5.2 <4.6.0 || ^4.6.1`,
so a deployment locked to 4.6.0 gets a peer warning.

Nuxt 4.6.0 broke Vite's dependency scan in any app that uses `@nuxtjs/i18n` (nuxt/nuxt#36473), so
`nuxt dev` found every dependency while the page loaded and reloaded the page after each batch. The
peer range only warns: the fix is the `nuxt` upgrade. A deployment that links the layer from a
workspace, not from `node_modules`, must also add the layer's files as scan entries, because Nuxt
adds them only for an installed layer. The in-repo frontend deployment
(`deploy/frontend/nuxt.config.ts`) shows how.
