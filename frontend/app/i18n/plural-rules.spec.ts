import { describe, expect, it } from 'vitest'
import { allowedFormCounts, pluralRules, type OverriddenLocale } from './plural-rules'

// The slot order each overridden locale's CLDR categories fill, matching `plural-rules.ts`.
// Naming them as CLDR category strings is what lets the tests below compare against
// `Intl.PluralRules`, the platform's own copy of the same CLDR data: a hand-written rule that
// drifts from ICU (because CLDR revised the locale, or because the rule was wrong to begin
// with) fails here instead of quietly rendering the wrong form.
const CATEGORY_ORDER: Record<OverriddenLocale, readonly Intl.LDMLPluralRule[]> = {
  pl: ['one', 'few', 'many'],
  uk: ['one', 'few', 'many'],
  he: ['one', 'two', 'other'],
}

const LOCALES = Object.keys(CATEGORY_ORDER) as OverriddenLocale[]

/** The CLDR category a selector resolves `n` to, for an entry carrying only the CLDR forms. */
function categoryFor(locale: OverriddenLocale, n: number): Intl.LDMLPluralRule {
  const order = CATEGORY_ORDER[locale]
  return order[pluralRules[locale](n, order.length)]!
}

describe('plural selectors agree with Intl.PluralRules', () => {
  // Every whole count a UI badge can plausibly show. The Slavic rules key off n % 100, and
  // Hebrew's off n itself, so 0..1000 exercises both far past their period.
  it.each(LOCALES)('%s over whole counts 0..1000', (locale) => {
    const icu = new Intl.PluralRules(locale)
    const disagreements = Array.from({ length: 1001 }, (_, n) => n)
      .map((n) => ({ n, ours: categoryFor(locale, n), icu: icu.select(n) }))
      .filter(({ ours, icu: theirs }) => ours !== theirs)
    expect(disagreements).toEqual([])
  })

  // Hebrew is exact over fractions too. The Slavic locales are deliberately not: CLDR routes
  // their fractions to an `other` category the 3-form catalogs carry no slot for, so the rule
  // folds those onto `many` (documented in `plural-rules.ts`) and cannot be compared here.
  it('he over fractional counts', () => {
    const icu = new Intl.PluralRules('he')
    const fractions = [0.1, 0.5, 0.9, 1.1, 1.5, 2.5, 3.5, 10.5, 20.5, 100.5]
    for (const n of fractions) expect(categoryFor('he', n)).toBe(icu.select(n))
  })

  it('treats a negative count as its magnitude', () => {
    for (const locale of LOCALES) {
      for (const n of [1, 2, 3, 5, 22]) {
        expect(pluralRules[locale](-n, 3)).toBe(pluralRules[locale](n, 3))
      }
    }
  })
})

describe('the leading zero form', () => {
  // One optional slot may precede the CLDR forms: a copy nicety ("no participants"), NOT a
  // CLDR category. An entry that carries it shifts every other slot by one, which is why the
  // form count is part of the contract rather than an authoring detail.
  it('is selected only for 0, and only when the entry carries it', () => {
    for (const locale of LOCALES) {
      const [cldrOnly, withZero] = allowedFormCounts(locale) as [number, number]
      expect(pluralRules[locale](0, withZero)).toBe(0)
      // Without a zero slot, 0 falls to whatever category the locale puts it in, never to
      // the `one` form.
      expect(pluralRules[locale](0, cldrOnly)).not.toBe(0)
      for (const n of [1, 2, 3, 5, 11, 22]) {
        expect(pluralRules[locale](n, withZero)).toBe(pluralRules[locale](n, cldrOnly) + 1)
      }
    }
  })
})

describe('an entry with too few forms', () => {
  // A short entry is a CI failure (`scripts/i18n-plural-forms.mjs`). At RUNTIME the selector
  // still has to answer with an in-range index: vue-i18n indexes the form array raw and throws
  // out of `t()` on an out-of-range answer, which blanks the whole surface rendering it rather
  // than degrading to an approximate form.
  it('clamps to the last form instead of running off the end', () => {
    for (const locale of LOCALES) {
      for (const forms of [1, 2]) {
        for (let n = 0; n <= 200; n++) {
          const index = pluralRules[locale](n, forms)
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(forms)
        }
      }
    }
  })
})

describe('hebrew', () => {
  // The behaviour this module exists to add: 2 is its own form, where the default 2-form
  // selector lumped it in with the plural.
  it('gives 2 a form of its own', () => {
    const forms = ['one', 'two', 'other']
    expect(forms[pluralRules.he(1, 3)]).toBe('one')
    expect(forms[pluralRules.he(2, 3)]).toBe('two')
    expect(forms[pluralRules.he(3, 3)]).toBe('other')
    expect(forms[pluralRules.he(20, 3)]).toBe('other')
  })
})
