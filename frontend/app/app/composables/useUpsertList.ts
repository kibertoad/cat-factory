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

  function indexOf(keyValue: unknown): number {
    return items.value.findIndex((x) => opts.key(x) === keyValue)
  }

  function upsert(item: T) {
    const i = indexOf(opts.key(item))
    if (i >= 0) items.value[i] = item
    else if (opts.prepend) items.value.unshift(item)
    else items.value.push(item)
  }

  function remove(keyValue: unknown) {
    const i = indexOf(keyValue)
    if (i >= 0) items.value.splice(i, 1)
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
