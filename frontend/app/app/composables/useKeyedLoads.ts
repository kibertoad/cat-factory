import { ref } from 'vue'
import { isModuleOffRefusal } from '~/composables/api/errors'

/**
 * The per-key bookkeeping of a store that loads one record per key (a block's review): which keys
 * are loading, which keys' last load failed, and one in-flight request per key.
 *
 * A load never rejects. The module-off 503 calls `onModuleOff` (the store's `available` goes
 * false); any other failure marks the key failed, so its surface can tell "could not ask" from
 * "nothing here" (AGENTS.md, "Degrade loudly"). A later success clears the mark.
 */
export function useKeyedLoads(options: { onModuleOff: () => void }) {
  const loading = ref<Set<string>>(new Set())
  const failed = ref<Set<string>>(new Set())
  // Plain Map, not reactive: one shared request per key, dropped when it settles or on `reset`.
  const inFlight = new Map<string, Promise<void>>()

  function mark(set: typeof loading, key: string, on: boolean) {
    if (set.value.has(key) === on) return
    const next = new Set(set.value)
    if (on) next.add(key)
    else next.delete(key)
    set.value = next
  }

  /** Run `fetch` for `key`, or join the load already running for it. */
  function run(key: string, fetch: () => Promise<void>): Promise<void> {
    const pending = inFlight.get(key)
    if (pending) return pending
    const promise = (async () => {
      mark(loading, key, true)
      try {
        await fetch()
        mark(failed, key, false)
      } catch (error) {
        if (isModuleOffRefusal(error)) options.onModuleOff()
        else mark(failed, key, true)
      } finally {
        mark(loading, key, false)
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
    return promise
  }

  function reset() {
    loading.value = new Set()
    failed.value = new Set()
    inFlight.clear()
  }

  return {
    isLoading: (key: string) => loading.value.has(key),
    loadFailed: (key: string) => failed.value.has(key),
    run,
    reset,
  }
}
