import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedFormCounts, type OverriddenLocale } from './plural-rules'

// Catalog invariant for the locales whose plural selector is overridden (`plural-rules.ts`).
//
// Neither existing i18n gate can see this class of breakage. `i18n:check` only asks whether a
// key EXISTS, and the locale-parity guard only asks whether a key MOVED with `en`; both pass on
// a `he` entry that carries the wrong NUMBER of pipe-separated forms. The damage is silent and
// total: the form count is what tells the selector whether the entry leads with a zero form, so
// one form too few does not drop a case, it re-points every remaining slot onto a different
// count. Too few forms outright is worse still, since the clamp then renders one form for
// several distinct counts.
//
// (This lives as a test rather than a `scripts/*.mjs` guard like its two neighbours so it can
// import the slot contract from `plural-rules.ts` instead of restating the allowed counts,
// which is precisely the coupling that would rot.)

const LOCALES: OverriddenLocale[] = ['pl', 'uk', 'he']
const SOURCE_LOCALE = 'en'

// Resolved off the vitest root (the package dir) rather than `import.meta.url`, which the
// happy-dom environment rewrites to a server-root-relative path.
function loadCatalog(locale: string): Map<string, string> {
  const path = join(process.cwd(), 'i18n', 'locales', `${locale}.json`)
  const out = new Map<string, string>()
  const walk = (node: unknown, prefix: string) => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // `@<key>` siblings are translator notes, live only in `en`, and are never rendered —
      // their prose may contain a pipe without being a plural.
      if (key.startsWith('@')) continue
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') out.set(path, value)
      else if (value && typeof value === 'object') walk(value, path)
    }
  }
  walk(JSON.parse(readFileSync(path, 'utf8')), '')
  return out
}

const catalogs = new Map(
  [SOURCE_LOCALE, ...LOCALES].map((locale) => [locale, loadCatalog(locale)] as const),
)

/**
 * A pipe written as vue-i18n LITERAL INTERPOLATION (`{'|'}`) is a character the message renders,
 * not a form separator: the compiler parses such a message as a plain Message rather than a
 * Plural. So it is stripped before the split, or a message that legitimately shows a pipe (the
 * reference-image field describes a `role|location|service` line) is measured as forms it does
 * not have.
 *
 * Getting this wrong is not merely a false positive. Counting the escaped pipes made a two-pipe
 * message read as three forms, which is a LEGAL count for every locale here, so the sibling key
 * that happened to carry one pipe failed while the more visible one passed silently. A guard that
 * mis-measures does not fail honestly; it fails somewhere else.
 */
const LITERAL_INTERPOLATION = /\{\s*'(?:[^'\\]|\\.)*'\s*\}/g

/** Pipe-separated plural entries only; a message with no pipe never reaches a selector. */
function pluralEntries(locale: string): [string, string[]][] {
  return [...catalogs.get(locale)!]
    .map(([key, value]) => [key, value.replace(LITERAL_INTERPOLATION, '')] as const)
    .filter(([, value]) => value.includes('|'))
    .map(([key, value]) => [key, value.split('|')])
}

describe.each(LOCALES)('%s plural entries', (locale) => {
  const allowed = allowedFormCounts(locale)

  it(`carry ${allowed.join(' or ')} forms`, () => {
    const offenders = pluralEntries(locale)
      .filter(([, forms]) => !allowed.includes(forms.length))
      .map(([key, forms]) => `${key}: ${forms.length} forms (expected ${allowed.join(' or ')})`)
    expect(offenders).toEqual([])
  })

  // The mirror image: a key `en` pluralizes but this locale renders as one flat string never
  // reaches the selector at all, so it reads as a singular at every count. Nothing else notices,
  // because the key is present and moved with `en` exactly as both other gates require.
  it('pluralize every key `en` pluralizes', () => {
    const catalog = catalogs.get(locale)!
    const missing = pluralEntries(SOURCE_LOCALE)
      .map(([key]) => key)
      .filter((key) => {
        const translated = catalog.get(key)
        return translated !== undefined && !translated.includes('|')
      })
    expect(missing).toEqual([])
  })
})
