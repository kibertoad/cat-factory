// vue-i18n options for the @cat-factory/app layer. Referenced from `nuxt.config.ts`
// as the bare filename `i18n.config.ts` so @nuxtjs/i18n resolves it per-layer (see the
// `i18n` block there). `defineI18nConfig` is auto-imported by the module.
//
// Locale MESSAGES are NOT defined here — they live in `i18n/locales/*.json` so the
// module can deep-merge them across the `extends` layer chain. This file carries only
// the runtime vue-i18n behaviour (fallback, number/date formats) shared by every locale.
export default defineI18nConfig(() => ({
  legacy: false,
  fallbackLocale: 'en',

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
  },
}))
