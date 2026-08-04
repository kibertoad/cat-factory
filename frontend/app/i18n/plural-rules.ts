// Per-locale plural SELECTORS for vue-i18n: given a count and how many forms a catalog entry
// carries, return the index of the form to render. Wired onto `pluralRules` in `i18n.config.ts`;
// this module is deliberately free of Nuxt/vue-i18n imports so it unit-tests as pure logic
// (`plural-rules.spec.ts`).
//
// vue-i18n's BUILT-IN selector implements neither Slavic nor Semitic agreement: for a 2-form
// entry it picks index 0 when n === 1 and index 1 otherwise, and for a 3-form entry it picks
// 0/1/2 for n === 0 / n === 1 / n > 1. That is right for `en`/`es`/`fr`/`de`/`it`/`ja`/`tr`
// (which are therefore NOT listed here) and wrong everywhere below.
//
// ## The slot contract a catalog entry declares by its FORM COUNT
//
// A locale's CLDR categories fill the trailing slots, in the order named by `CLDR_CATEGORIES`
// below. One optional slot may precede them: a ZERO form, which is a COPY nicety rather than a
// CLDR category ("no participants" reads better than "0 participants") and which `en` already
// uses. So for a locale with 3 CLDR categories:
//
//   3 forms  ->  <cat0> | <cat1> | <cat2>
//   4 forms  ->  zero | <cat0> | <cat1> | <cat2>
//
// The count is therefore load-bearing: dropping a form does not degrade the message, it
// RE-POINTS every remaining slot onto a different count. `scripts/i18n-plural-forms.mjs` fails
// CI on an entry whose form count is not one of the two shapes, because nothing else can catch
// it (a short entry renders confidently and wrongly, and vue-i18n throws outright when a
// selector returns an index past the end).

/** A vue-i18n plural selector: `(count, formsInThisEntry) => index of the form to render`. */
export type PluralSelector = (choice: number, choicesLength: number) => number

// Polish and Ukrainian share the `few` bucket but NOT the `one` bucket, and one rule serving
// both is what this pair of functions replaced: Polish reserves `one` for exactly 1, while
// Ukrainian gives it to every count ending in 1 except the teens, so 21/31/…/101 were rendering
// the `many` form ("21 репозиторіїв" for "21 репозиторій") on 89 of the first 1000 counts.
const slavicFew = (mod10: number, mod100: number): boolean =>
  mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)

/**
 * Polish one/few/many, e.g. "decyzja | decyzje | decyzji".
 *
 * CLDR also gives Polish an `other` category, reached only by fractional counts. The catalogs
 * carry no slot for it and a count here is always a whole number of things, so a fraction
 * collapses onto `many`, which is the form Polish uses for a decimal anyway ("2,5 decyzji").
 * The same holds for Ukrainian below.
 */
const polishCategory = (n: number): number => {
  if (n === 1) return 0 // one
  if (slavicFew(n % 10, n % 100)) return 1 // few
  return 2 // many (incl. 0, 5-21, ...)
}

/** Ukrainian one/few/many, e.g. "рішення | рішення | рішень". */
const ukrainianCategory = (n: number): number => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 0 // one (1, 21, 31, ..., 101, ...)
  if (slavicFew(mod10, mod100)) return 1 // few
  return 2 // many (incl. 0, 5-20, ...)
}

/**
 * Hebrew one/two/other (CLDR `he`): a distinct DUAL, which is why running `he` on the default
 * 2-form selector made every count message an approximation. n === 2 takes its own form, both
 * for the lexical duals ("יומיים" for two days, "פעמיים" for twice) and for the spelled-out
 * numeral ordinary prose wants ("שתי משימות" rather than "2 משימות").
 *
 * Fractions follow CLDR too: a count below 1 is `one` (0.5 -> "one"), a fractional count at or
 * above 1 is `other`. `plural-rules.spec.ts` asserts the whole domain against `Intl.PluralRules`,
 * so an ICU/CLDR revision to Hebrew fails a test rather than silently disagreeing with the
 * platform's own formatter.
 *
 * Note the CLDR rule has THREE categories, not the four (one/two/many/other) it carried before
 * the `many` bucket for round tens was retired: modern Hebrew does not inflect for it, so asking
 * a translator to author that form would only produce a duplicate of `other`.
 */
const hebrewCategory = (n: number): number => {
  const integerPart = Math.floor(n)
  if (n !== integerPart) return integerPart === 0 ? 0 : 2 // one below 1, otherwise other
  if (integerPart === 1) return 0 // one
  if (integerPart === 2) return 1 // two
  return 2 // other (incl. 0)
}

/** How many CLDR categories each overridden locale's rule resolves, in slot order. */
const CLDR_CATEGORIES = {
  pl: { count: 3, category: polishCategory },
  uk: { count: 3, category: ukrainianCategory },
  he: { count: 3, category: hebrewCategory },
} as const

/** The locales whose plural selector is overridden, i.e. the ones the form-count guard covers. */
export type OverriddenLocale = keyof typeof CLDR_CATEGORIES

/**
 * The form counts a catalog entry may carry in `locale`: the CLDR categories alone, or those
 * preceded by the optional zero form. Exported so the CI guard and this module agree on the
 * contract by construction instead of by two copies of the same numbers.
 */
export function allowedFormCounts(locale: OverriddenLocale): readonly number[] {
  const { count } = CLDR_CATEGORIES[locale]
  return [count, count + 1]
}

function selectorFor(locale: OverriddenLocale): PluralSelector {
  const { count: cldrForms, category } = CLDR_CATEGORIES[locale]
  return (choice, choicesLength) => {
    const n = Math.abs(choice)
    // More forms than the locale has categories means the entry leads with a zero form.
    const hasZeroForm = choicesLength > cldrForms
    if (hasZeroForm && n === 0) return 0
    const index = (hasZeroForm ? 1 : 0) + category(n)
    // An entry with too FEW forms is a CI failure, not a runtime one: clamping renders the
    // nearest form instead of handing vue-i18n an out-of-range index, which it rejects by
    // throwing out of `t()` and blanking whatever was rendering the message.
    return Math.min(index, choicesLength - 1)
  }
}

/** vue-i18n's `pluralRules` map: only the locales the built-in selector gets wrong. */
export const pluralRules: Record<OverriddenLocale, PluralSelector> = {
  pl: selectorFor('pl'),
  uk: selectorFor('uk'),
  he: selectorFor('he'),
}
