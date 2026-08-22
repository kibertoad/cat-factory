import { describe, expect, it } from 'vitest'
import { useUpsertList } from '~/composables/useUpsertList'

interface Item {
  id: string
  v: number
}

describe('useUpsertList', () => {
  it('appends new items by default and replaces in place by key', () => {
    const { items, upsert } = useUpsertList<Item>({ key: (x) => x.id })
    upsert({ id: 'a', v: 1 })
    upsert({ id: 'b', v: 2 })
    upsert({ id: 'a', v: 9 }) // replace, not duplicate
    expect(items.value).toEqual([
      { id: 'a', v: 9 },
      { id: 'b', v: 2 },
    ])
  })

  it('prepends new items when prepend is set (newest-first)', () => {
    const { items, upsert } = useUpsertList<Item>({ key: (x) => x.id, prepend: true })
    upsert({ id: 'a', v: 1 })
    upsert({ id: 'b', v: 2 })
    expect(items.value.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('replaces an existing item in place under prepend (no reorder)', () => {
    // The github `pulls` list is prepend (newest-first); re-opening / optimistically
    // merging an existing PR must replace it where it sits, not bump it to the front.
    const { items, upsert } = useUpsertList<Item>({ key: (x) => x.id, prepend: true })
    upsert({ id: 'a', v: 1 })
    upsert({ id: 'b', v: 2 })
    upsert({ id: 'a', v: 9 }) // existing key → replace in place
    expect(items.value).toEqual([
      { id: 'b', v: 2 },
      { id: 'a', v: 9 },
    ])
  })

  it('removes by key and looks up by key', () => {
    const { items, upsert, remove, get } = useUpsertList<Item>({ key: (x) => x.id })
    upsert({ id: 'a', v: 1 })
    upsert({ id: 'b', v: 2 })
    expect(get('b')).toEqual({ id: 'b', v: 2 })
    remove('a')
    expect(items.value.map((x) => x.id)).toEqual(['b'])
    remove('missing') // no-op
    expect(items.value).toHaveLength(1)
  })

  it('supports composite keys and hydrate-from-snapshot', () => {
    interface Doc {
      source: string
      externalId: string
    }
    const { items, upsert, hydrate } = useUpsertList<Doc>({
      key: (d) => `${d.source}:${d.externalId}`,
    })
    hydrate([{ source: 'jira', externalId: '1' }])
    upsert({ source: 'jira', externalId: '1' }) // same composite key → replace
    upsert({ source: 'gh', externalId: '1' }) // different source → new
    expect(items.value).toHaveLength(2)
  })

  // Lookups run off a lazily-rebuilt key -> position map. Every write that MOVES an existing
  // position has to invalidate it, and so does a caller replacing `items` wholesale (which the
  // returned ref deliberately allows). A stale index answers with the wrong row, so these assert
  // the identity of what comes back, not just that something did.
  describe('key index coherence', () => {
    it('answers correctly after a prepend has shifted every later position', () => {
      const { upsert, get, indexOf } = useUpsertList<Item>({ key: (x) => x.id, prepend: true })
      upsert({ id: 'a', v: 1 })
      expect(indexOf('a')).toBe(0)
      upsert({ id: 'b', v: 2 })
      expect(indexOf('a')).toBe(1)
      expect(get('a')).toEqual({ id: 'a', v: 1 })
    })

    it('answers correctly after a removal has shifted every later position', () => {
      const { upsert, remove, get, indexOf } = useUpsertList<Item>({ key: (x) => x.id })
      upsert({ id: 'a', v: 1 })
      upsert({ id: 'b', v: 2 })
      upsert({ id: 'c', v: 3 })
      expect(indexOf('c')).toBe(2)
      remove('a')
      expect(indexOf('c')).toBe(1)
      expect(get('b')).toEqual({ id: 'b', v: 2 })
      expect(get('a')).toBeUndefined()
    })

    it('answers correctly after the caller replaces the list wholesale', () => {
      const { items, upsert, get } = useUpsertList<Item>({ key: (x) => x.id })
      upsert({ id: 'a', v: 1 })
      items.value = [
        { id: 'b', v: 2 },
        { id: 'a', v: 7 },
      ]
      expect(get('a')).toEqual({ id: 'a', v: 7 })
      expect(get('b')).toEqual({ id: 'b', v: 2 })
    })

    it('answers correctly after hydrate replaces the list', () => {
      const { upsert, hydrate, get } = useUpsertList<Item>({ key: (x) => x.id })
      upsert({ id: 'a', v: 1 })
      expect(get('a')).toEqual({ id: 'a', v: 1 })
      hydrate([{ id: 'b', v: 2 }])
      expect(get('a')).toBeUndefined()
      expect(get('b')).toEqual({ id: 'b', v: 2 })
    })
  })

  it('seeds from initial without aliasing the caller array', () => {
    const seed: Item[] = [{ id: 'a', v: 1 }]
    const { items, upsert } = useUpsertList<Item>({ key: (x) => x.id, initial: seed })
    upsert({ id: 'b', v: 2 })
    expect(items.value).toHaveLength(2)
    expect(seed).toHaveLength(1) // original untouched
  })
})
