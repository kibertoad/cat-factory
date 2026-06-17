---
'@cat-factory/app': patch
---

Fix `use*Store is not defined` at app boot when the layer is consumed via
`extends`. `@pinia/nuxt`'s default `storesDirs` is an absolute path resolved
against the consumer's `srcDir`, so once the SPA was split into this layer +
example deployment the layer's own `stores/` were never auto-imported. Set a
relative `pinia.storesDirs` (`['stores']`) so the module re-resolves it against
each layer's app directory and the layer's Pinia stores auto-import in any
consumer.
