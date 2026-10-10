import { describe, expect, it } from 'vitest'
import { FRAGMENTS } from './index.js'

describe('shipped fragment catalog', () => {
  it('carries no id collision across its collections', () => {
    // Ids are persisted on blocks and the registry REPLACES on re-registration, so a duplicate
    // would silently shadow another fragment's body. The catalog owns this invariant, not any one
    // collection: a per-collection copy fires everywhere at once and names no culprit.
    const ids = FRAGMENTS.map((fragment) => fragment.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    expect(duplicates).toEqual([])
  })
})
