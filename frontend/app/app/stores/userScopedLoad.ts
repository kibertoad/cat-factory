import { ref } from 'vue'
import { isAbsentFeatureRefusal } from '~/composables/api/errors'

/**
 * The load half of a user-scoped list store (user secrets, local runners, personal
 * subscriptions). `fetch` reads the list and `apply` stores it; on failure `reset` empties it.
 *
 * `loadFailed` is what lets a reader tell "nothing connected" from "did not load": a refusal
 * that means nothing to show (`isAbsentFeatureRefusal`) clears it, and any other failure sets
 * it. Two surfaces can call `load()` at once (a hub and the panel it opens), so only the most
 * recently started call settles the state; an older one that lands later is dropped.
 */
export function createUserScopedLoad<T>(options: {
  fetch: () => Promise<T>
  apply: (value: T) => void
  reset: () => void
}) {
  const loading = ref(false)
  const loadFailed = ref(false)
  let latest = 0

  async function load() {
    const call = ++latest
    loading.value = true
    try {
      const value = await options.fetch()
      if (call !== latest) return
      options.apply(value)
      loadFailed.value = false
    } catch (err) {
      if (call !== latest) return
      loadFailed.value = !isAbsentFeatureRefusal(err)
      options.reset()
    } finally {
      if (call === latest) loading.value = false
    }
  }

  return { loading, loadFailed, load }
}
