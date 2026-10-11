---
'@cat-factory/app': patch
---

Pre-bundle the SPA's dependencies on a cold `nuxt dev`, so the first page load no longer reloads.

Nuxt 4.6.0 broke Vite's dependency scan in any app that uses `@nuxtjs/i18n` (nuxt/nuxt#36473), so
`nuxt dev` found every dependency while the page loaded and reloaded the page after each batch. The
layer now develops against Nuxt 4.6.1, which has the fix. The in-repo frontend deployment also lists
the layer's own files as scan entries, because Nuxt adds them only for a layer installed in
`node_modules`, and pnpm links this one from `frontend/app`.
