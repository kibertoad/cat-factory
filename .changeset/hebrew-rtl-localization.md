---
'@cat-factory/app': minor
---

Add Hebrew (`he`) localization with right-to-left (RTL) support.

- New `he` locale registered in `nuxt.config.ts` (with `dir: 'rtl'`) plus Hebrew
  `numberFormats`/`datetimeFormats`, and a full `i18n/locales/he.json` catalog mirroring
  `en.json` (machine-translated, flagged for native-speaker review; ~2% of leaves are
  intentionally left as brand/technical tokens).
- The document `<html dir>`/`lang` now track the active locale via `useLocaleHead()` in
  `app.vue`, so selecting Hebrew flips the UI to RTL.
- Converted physical-direction Tailwind utilities to logical equivalents across the
  component tree (`ml-`→`ms-`, `pr-`→`pe-`, `left-`→`start-`, `border-l`→`border-s`,
  `text-left`→`text-start`, etc.) so layout mirrors automatically under RTL; the sidebar
  drawer slide and horizontal chevron/arrow icons get explicit `rtl:` handling.
