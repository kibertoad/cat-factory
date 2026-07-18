---
'@cat-factory/app': minor
---

Adopt modular-vue in the Nuxt layer (slice 0: registry in the layer). Wires a
`@modular-vue/runtime` registry and a client plugin (`installModularApp`) into
`@cat-factory/app` behind zero behaviour change, and adds the consumer
contribution seam: a deployment extending the layer registers its own feature
modules via the auto-imported `registerAppModule(...)` from its own plugin. No
UI reads the registry yet; later slices convert navigation, result views,
wizards, and inspector panels into modules registered through this seam. Bumps
`vue` to `3.5.40` (the `@modular-vue/*` peer floor).
