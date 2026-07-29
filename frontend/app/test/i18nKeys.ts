import enCatalog from '../i18n/locales/en.json'

/**
 * Resolve a dotted vue-i18n key against the layer's base `en` catalog.
 *
 * The drift guards described in CLAUDE.md leave exactly one gap, and this closes it. Typed
 * message keys only see a key written literally as `t('a.b.c')`, and `vue-i18n-extract`
 * (`i18n:check`) scans for the same shape — so a key held in a `Record<SomeEnum, string>`
 * lookup table is invisible to both. The exhaustive `Record` proves every ENUM MEMBER has an
 * entry; nothing proves the entry still names a key that exists. Deleting the key then reads
 * as a clean removal: every check passes and the button renders its own key path at runtime.
 *
 * So a spec that owns such a table asserts its VALUES here. Shared rather than re-declared per
 * spec, because a private copy is one more thing that can quietly stop being run.
 */
const en = enCatalog as Record<string, unknown>

/** True when the dotted path resolves to a leaf string in the base catalog. */
export function hasI18nKey(path: string): boolean {
  let node: unknown = en
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

/**
 * Assertion-friendly projection: the subset of `keys` that does NOT resolve. Prefer
 * `expect(missingI18nKeys(...)).toEqual([])` over a per-key loop — a failure then names every
 * broken key at once instead of stopping at the first.
 */
export function missingI18nKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => !hasI18nKey(key))
}
