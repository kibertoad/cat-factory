---
'@cat-factory/storybook': patch
---

Bump `@storybook-vue/nuxt` to `10.0.2`, which ships the Nuxt 4.6 app-context fix
(nuxt-modules/storybook#1139). The local pnpm patch now carries only the fix for the empty canvas
id under `@storybook/addon-vitest` (nuxt-modules/storybook#1140).
