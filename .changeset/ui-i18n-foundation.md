---
'@cat-factory/app': minor
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
---

Add internationalization (i18n) foundation to the SPA via `@nuxtjs/i18n`. The Nuxt layer
now ships a `i18n/` config + `en` locale catalog and resolves user-facing copy through
vue-i18n message keys. Downstream deployments can override or add locales by dropping their
own `i18n/locales/*.json` (per-layer deep-merge, consumer wins).

Note for consumers: the published layer now depends on `@nuxtjs/i18n` (and pulls in
vue-i18n), so a downstream `extends` of `@cat-factory/app` gains that dependency weight.

Maintainability is guarded in two tiers. Typed message keys
(`i18n.experimental.typedOptionsAndMessages`) make a statically written unknown `t()` key a
`nuxt typecheck` failure. Because that cannot see a key assembled at runtime, enum→key
lookups are additionally guarded by an exhaustive `Record<TheEnum, string>` keyed off the
source-of-truth union — adding an enum value without a key fails the typecheck on the map.

To make that source of truth reachable by the SPA, the `ConflictReason` wire vocabulary
moves from `@cat-factory/kernel` to `@cat-factory/contracts` (kernel re-exports it, so
backend imports are unchanged).

First migrated surface: the pipeline-error toast (`usePipelineErrorToast`), which now
resolves conflict titles from `errors.conflict.*` keys via an exhaustive `ConflictReason`
map and shows raw backend prose only as an untranslated fallback. Most other components
still hold inline strings — the sweep is incremental.
