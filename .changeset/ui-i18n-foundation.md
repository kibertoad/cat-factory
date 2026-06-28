---
"@cat-factory/app": minor
---

Add internationalization (i18n) foundation to the SPA via `@nuxtjs/i18n`. The Nuxt layer
now ships a `i18n/` config + `en` locale catalog and resolves user-facing copy through
vue-i18n message keys. Downstream deployments can override or add locales by dropping their
own `i18n/locales/*.json` (per-layer deep-merge, consumer wins).

Typed message keys are enabled so an unknown `t()` key fails `nuxt typecheck` — the
maintainability guardrail given the repo lints with oxlint only (no `no-raw-text` ESLint
rule available).

First migrated surface: the pipeline-error toast (`usePipelineErrorToast`), which now
resolves conflict titles from `errors.conflict.*` keys by the backend's machine-readable
`reason` and shows raw backend prose only as an untranslated fallback. Most other
components still hold inline strings — the sweep is incremental.
