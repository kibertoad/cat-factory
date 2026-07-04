import { describe, expect, it } from 'vitest'
import type { MergePrEntry } from '@cat-factory/kernel'
import { orderPrsForMerge } from './mergeOrder.logic.js'

const ref = (n: number) => ({
  url: `https://github.com/o/r/pull/${n}`,
  number: n,
  branch: 'cat-factory/b',
})

describe('orderPrsForMerge', () => {
  it('returns 0- and 1-entry lists unchanged', () => {
    expect(orderPrsForMerge([])).toEqual([])
    const one: MergePrEntry[] = [{ ref: ref(1) }]
    expect(orderPrsForMerge(one)).toEqual(one)
  })

  it('merges providers (peers) before the consumer (own) PR', () => {
    // `allPullRequests` yields own first; the merge order must invert that so providers land first.
    const entries: MergePrEntry[] = [
      { ref: ref(1) }, // own service (no repo)
      { repo: 'o/email', frameId: 'frm_email', ref: ref(2) },
      { repo: 'o/auth', frameId: 'frm_auth', ref: ref(3) },
    ]
    const ordered = orderPrsForMerge(entries)
    // Own service (the consumer) is last; peers first, sorted deterministically by frame id.
    expect(ordered.map((e) => e.repo ?? 'own')).toEqual(['o/auth', 'o/email', 'own'])
  })

  it('orders peers deterministically by frame id (falling back to repo name)', () => {
    const entries: MergePrEntry[] = [
      { repo: 'o/z', ref: ref(1) },
      { repo: 'o/a', ref: ref(2) },
      { ref: ref(3) },
    ]
    expect(orderPrsForMerge(entries).map((e) => e.repo ?? 'own')).toEqual(['o/a', 'o/z', 'own'])
  })
})
