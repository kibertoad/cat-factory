// vue-i18n options for the @cat-factory/app layer. Referenced from `nuxt.config.ts`
// as the bare filename `i18n.config.ts` so @nuxtjs/i18n resolves it per-layer (see the
// `i18n` block there). `defineI18nConfig` is auto-imported by the module.
//
// Locale MESSAGES are NOT defined here — they live in `i18n/locales/*.json` so the
// module can deep-merge them across the `extends` layer chain. This file carries only
// the runtime vue-i18n behaviour (fallback, number/date formats) shared by every locale.
// Slavic one/few/many plural selector (CLDR rule for Polish & Ukrainian), returning the
// 0|1|2 index into a 3-form `"one | few | many"` message. vue-i18n's BUILT-IN pluralizer
// only ever picks index 0 (n===1) or 1/2 by a non-Slavic rule, so without this the pl/uk
// 3-form catalog entries (e.g. board.toolbar.decisionWord "decyzja | decyzje | decyzji")
// render the WRONG form for counts like 2-4 and 22-24. `choicesLength` is unused — the
// three forms are assumed; en/es/fr keep the default 2-form behaviour (not listed here).
const slavicPluralRule = (choice: number): number => {
  const n = Math.abs(choice)
  const mod10 = n % 10
  const mod100 = n % 100
  if (n === 1) return 0 // one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1 // few
  return 2 // many (incl. 0, 5-21, …)
}

export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en',

  // Per-locale plural selectors. Only the Slavic locales need overriding; the others use
  // vue-i18n's default (correct for their 2-form catalogs).
  pluralRules: {
    pl: slavicPluralRule,
    uk: slavicPluralRule,
  },

  // Locale-aware number/currency formatting. Use `$n(value, 'currency')` etc. at call
  // sites instead of a raw `Intl.NumberFormat`; `$n`/`$d` are thin `Intl` wrappers so
  // `en` behaviour is identical. `currency` style needs a `currency` override per call
  // (`$n(n, 'currency', { currency: s.currency })`) — the backend supplies the code.
  numberFormats: {
    en: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    es: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    pl: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    uk: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    fr: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    de: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    it: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    he: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    ja: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
    tr: {
      decimal: { style: 'decimal' },
      currency: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
      percent: { style: 'percent', maximumFractionDigits: 1 },
    },
  },
  datetimeFormats: {
    en: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    es: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    pl: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    uk: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    fr: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    de: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    it: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    he: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    ja: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
    tr: {
      short: { dateStyle: 'medium' },
      long: { dateStyle: 'long', timeStyle: 'short' },
    },
  },
}))
