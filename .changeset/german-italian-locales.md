---
'@cat-factory/app': minor
---

Add German (`de`) and Italian (`it`) locales. The `@cat-factory/app` layer now ships
`i18n/locales/de.json` and `i18n/locales/it.json` alongside the existing catalogs, both
registered in the `nuxt.config.ts` `i18n.locales` array and given `numberFormats` /
`datetimeFormats` entries in `i18n.config.ts`. Neither needs a custom plural selector (both
use vue-i18n's default two-form pluralization). The language switcher picks them up
automatically since it renders from the i18n locale list.
