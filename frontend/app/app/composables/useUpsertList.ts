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
    // Track the array's LENGTH on every path, the fresh-index fast path included. The Map is
    // plain, so a reader answered out of an already-fresh index would otherwise depend on nothing
    // but the `items` ref, and an in-place append leaves that ref's value the same array: a
    // computed that MISSED on a key would never re-run when the item it was waiting for arrives.
    // `length` is the dependency the `findIndex` this replaced established, and it moves on every
    // write that can turn a miss into a hit (push, unshift, splice) or shift a hit's position.
    // A replace in place moves neither, and a reader that resolved an item already tracks its
    // own index through the `items.value[i]` read below.
    void items.value.length
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
