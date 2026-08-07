import { describe, expect, it } from 'vitest'
import { documentFreshnessChangeSchema, documentFreshnessGapSchema } from '@cat-factory/contracts'
import { missingI18nKeys } from '../../../test/i18nKeys'
import { CHANGE_KEYS, GAP_KEYS } from './DocumentSyncState.logic'

/**
 * The half of these tables' correctness that no guard can see.
 *
 * `satisfies Record<TheEnum, string>` already proves every MEMBER has an entry, and CI's locale
 * parity plus `i18n:check` cover keys written literally as a translate call. A key held in a lookup
 * table is invisible to both, so deleting it from the catalog passes every check and renders its own
 * dotted path to the user (see `test/i18nKeys.ts`).
 *
 * The member lists are DERIVED from the picklists the component's types come from rather than
 * re-listed here: a re-listed copy would pass while the code under test had drifted, which is the
 * one failure mode a table test exists to catch.
 */
describe('DocumentSyncState freshness tables', () => {
  it('names a key the base catalog holds for every gap', () => {
    expect(missingI18nKeys(Object.values(GAP_KEYS))).toEqual([])
  })

  it('names a key the base catalog holds for every change outcome', () => {
    expect(missingI18nKeys(Object.values(CHANGE_KEYS))).toEqual([])
  })

  it('covers exactly the contracts vocabularies, with no entry for a member that is gone', () => {
    expect(Object.keys(GAP_KEYS).sort()).toEqual([...documentFreshnessGapSchema.options].sort())
    expect(Object.keys(CHANGE_KEYS).sort()).toEqual(
      [...documentFreshnessChangeSchema.options].sort(),
    )
  })
})
