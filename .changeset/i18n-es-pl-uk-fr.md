---
'@cat-factory/app': minor
---

Add Spanish (`es`), Polish (`pl`), Ukrainian (`uk`), and French (`fr`) locales to the
i18n layer. Each ships a full translation of the base `en` message catalog under
`i18n/locales/<locale>.json`, is registered in the `nuxt.config.ts` `i18n.locales`
array, and gets matching `numberFormats`/`datetimeFormats` entries in `i18n.config.ts`.
`en` remains the `defaultLocale` and `fallbackLocale`. A downstream deployment can still
override any of these by dropping its own `i18n/locales/*.json` (the per-layer deep-merge).
