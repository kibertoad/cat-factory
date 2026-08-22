import { type Ref, ref } from 'vue'

/**
 * A keyed list with find-by-key upsert — the pattern reimplemented in ~13 stores
 * (`const i = list.findIndex((x) => x.id === item.id); if (i >= 0) list[i] = item else …`).
 * Wraps a reactive `T[]` and exposes `upsert` (replace-in-place or insert), `remove`,
 * `get`, and `hydrate` (replace from a server snapshot), all keyed by a caller-supplied
 * `key` function. New items append by default, or `prepend: true` for newest-first inboxes.
 *
 * The returned `items` ref stays directly assignable, so a store can expose it under a
 * domain name (`const { items: documents, upsert } = useUpsertList(...)`) and callers /
 * tests can still do `store.documents = [...]`.
 */
export function useUpsertList<T>(opts: {
  /** Stable identity for an item (e.g. `(x) => x.id`, or `(x) => `${x.source}:${x.externalId}``). */
  key: (item: T) => unknown
  /** Insert position for a brand-new item: `true` ⇒ unshift (newest-first), else push. */
  prepend?: boolean
  /** Seed contents (copied, not aliased). */
  initial?: T[]
}): {
  items: Ref<T[]>
  upsert: (item: T) => void
  remove: (keyValue: unknown) => void
  get: (keyValue: unknown) => T | undefined
  hydrate: (next: T[]) => void
  indexOf: (keyValue: unknown) => number
} {
  const items = ref<T[]>(opts.initial ? [...opts.initial] : []) as Ref<T[]>

  /**
   * key -> position, rebuilt LAZILY.
   *
   * Every operation here was a `findIndex`, so a store's live-event path scanned its whole list
   * per event and each `get` scanned it again. The map is invalidated rather than maintained
   * because the two structural writes that move existing positions (a prepend, a removal) shift
   * every later index, and a burst of them must not pay a rebuild each: whoever reads next pays
   * for one. `indexedFor` also catches a caller REPLACING `items` wholesale, which the returned
   * ref deliberately allows.
   */
  let index = new Map<unknown, number>()
  let indexedFor: T[] | null = null

  function reindex(): Map<unknown, number> {
    if (indexedFor === items.value) return index
    index = new Map(items.value.map((item, i) => [opts.key(item), i]))
    indexedFor = items.value
    return index
  }

  /** Mark the index stale after a write that moved existing positions. */
  function invalidate() {
    indexedFor = null
  }

  function indexOf(keyValue: unknown): number {
    return reindex().get(keyValue) ?? -1
  }

  function upsert(item: T) {
    const key = opts.key(item)
    const i = indexOf(key)
    if (i >= 0) {
      // A replace in place moves nothing, so the index stays correct.
      items.value[i] = item
    } else if (opts.prepend) {
      items.value.unshift(item)
      invalidate()
    } else {
      // An append is the one structural write that moves nothing already indexed.
      items.value.push(item)
      if (indexedFor === items.value) index.set(key, items.value.length - 1)
    }
  }

  function remove(keyValue: unknown) {
    const i = indexOf(keyValue)
    if (i >= 0) {
      items.value.splice(i, 1)
      invalidate()
    }
  }

  function get(keyValue: unknown): T | undefined {
    const i = indexOf(keyValue)
    return i >= 0 ? items.value[i] : undefined
  }

  function hydrate(next: T[]) {
    items.value = [...next]
  }

  return { items, upsert, remove, get, hydrate, indexOf }
}
