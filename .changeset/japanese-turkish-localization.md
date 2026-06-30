---
'@cat-factory/app': minor
---

Add Japanese (`ja`) and Turkish (`tr`) localizations.

- New `ja` and `tr` locales registered in `nuxt.config.ts` (both left-to-right) plus matching
  `numberFormats`/`datetimeFormats` entries in `i18n.config.ts`, and full
  `i18n/locales/ja.json` + `i18n/locales/tr.json` catalogs mirroring `en.json`
  (machine-translated, flagged for native-speaker review). Placeholders, plural-pipe segment
  counts, and brand/technical tokens (e.g. `Kaizen`, GitHub, code/format examples) are
  preserved verbatim; the `@<key>` translator notes are source-only and omitted from the
  catalogs.
- No mechanism changes were required beyond the locale registration: text direction already
  tracks the active locale via `useLocaleHead()` in `app.vue` (both new locales are LTR), CJK
  glyphs render through the existing system-font fallback, and `pluralRules` stay unchanged
  (the default two-form selector covers Japanese's no-plural and Turkish's singular-after-count
  cases; only the Slavic locales need a custom rule).
