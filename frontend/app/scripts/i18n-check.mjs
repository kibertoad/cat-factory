/**
 * i18n drift guard (tier 3) — see CLAUDE.md → Internationalization.
 *
 * Tiers 1 (typed message keys) and 2 (exhaustive `Record<Enum,string>` maps) only catch
 * keys that are either written as static `t('literal')` calls or enumerated in a typed
 * map. They do NOT catch a `t('…')` whose key is absent from the catalog when the lookup
 * is built at runtime, and nothing reports stale catalog keys. This wrapper closes that
 * gap with `vue-i18n-extract`.
 *
 * It deliberately gates on MISSING keys only (a `t('…')` referencing a key not in the
 * catalog → a raw-key leak in the UI) and treats UNUSED keys as non-blocking warnings.
 * The CLI's `--ci` flag fails on both, which is why we drive the programmatic API: the
 * catalog intentionally seeds keys ahead of use (`common.save|cancel|retry`) and
 * references many keys indirectly (the `CONFLICT_TITLE_KEYS` Record, keys passed as
 * string literals to `usePipelineErrorToast().present(...)`), so the scanner can't see
 * those as "used" — an unused-key hard gate would fail on day one and fight the
 * incremental migration workflow.
 */

import { createI18NReport } from 'vue-i18n-extract'

const report = await createI18NReport({
  // Scans templates AND the composables/stores that resolve keys via `t()` / `$t()`.
  vueFiles: './app/**/*.{vue,ts}',
  // The v9+ `restructureDir` convention — `i18n/locales/`, NOT `app/locales/`.
  languageFiles: './i18n/locales/*.json',
})

const missing = report.missingKeys ?? []
const unused = report.unusedKeys ?? []

if (unused.length) {
  console.warn(`⚠ vue-i18n-extract: ${unused.length} unused catalog key(s) (non-blocking):`)
  for (const k of unused) console.warn(`   - ${k.path}  (${k.language})`)
}

if (missing.length) {
  console.error(
    `✗ vue-i18n-extract: ${missing.length} key(s) used in code but absent from the catalog:`,
  )
  for (const k of missing) console.error(`   - ${k.path}  in ${k.file}`)
  console.error('\nAdd each key to frontend/app/i18n/locales/en.json (or fix the typo).')
  process.exit(1)
}

console.log('✓ vue-i18n-extract: no missing i18n keys')
