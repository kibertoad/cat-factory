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
      { repo: 'o/email', frameIds: ['frm_email'], ref: ref(2) },
      { repo: 'o/auth', frameIds: ['frm_auth'], ref: ref(3) },
    ]
    const ordered = orderPrsForMerge(entries)
    // Own service (the consumer) is last; peers first, sorted deterministically by frame id.
    expect(ordered.map((e) => e.repo ?? 'own')).toEqual(['o/auth', 'o/email', 'own'])
  })

  // A monorepo peer carries several frames on its one PR, so its key is the LEAST of them:
  // a function of the set, which is what keeps the order independent of resolution order.
  it('keys a multi-frame peer on its least frame id, whatever order they arrive in', () => {
    const mono = (frameIds: string[]): MergePrEntry[] => [
      { repo: 'o/mono', frameIds, ref: ref(1) },
      { repo: 'o/other', frameIds: ['frm_b'], ref: ref(2) },
      { ref: ref(3) },
    ]
    const expected = ['o/mono', 'o/other', 'own']
    expect(orderPrsForMerge(mono(['frm_a', 'frm_z'])).map((e) => e.repo ?? 'own')).toEqual(expected)
    expect(orderPrsForMerge(mono(['frm_z', 'frm_a'])).map((e) => e.repo ?? 'own')).toEqual(expected)
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
