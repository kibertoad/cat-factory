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

  it('seeds from initial without aliasing the caller array', () => {
    const seed: Item[] = [{ id: 'a', v: 1 }]
    const { items, upsert } = useUpsertList<Item>({ key: (x) => x.id, initial: seed })
    upsert({ id: 'b', v: 2 })
    expect(items.value).toHaveLength(2)
    expect(seed).toHaveLength(1) // original untouched
  })
})
