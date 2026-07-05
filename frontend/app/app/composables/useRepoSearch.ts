import { computed, ref, watch } from 'vue'
import { refDebounced } from '@vueuse/core'
import type { GitHubAvailableRepo } from '~/types/domain'

/** Minimum characters before a search fires — a wide install has too many repos to prefetch. */
export const REPO_SEARCH_MIN_LEN = 3

/** How the picker searches: a debounced, min-length-gated, server-side repo search. */
export type RepoFetcher = (query: string) => Promise<GitHubAvailableRepo[]>

/**
 * Shared repo-lookup behaviour for the GitHub repo pickers (the add-service modal and the
 * doc-task reference-repo picker). A wide App install / PAT can expose hundreds of repos, so the
 * pickers search SERVER-SIDE rather than prefetching and filtering in the browser: once the user
 * types at least {@link REPO_SEARCH_MIN_LEN} characters the (debounced) query is sent to the
 * backend, which returns only the matches. Below the gate the list stays empty and the caller
 * shows a "type N chars" hint.
 *
 * The fetcher defaults to the github store's NON-mutating `searchAvailableRepos`, so each picker
 * keeps its OWN result list — two pickers never clobber each other through the shared
 * `availableRepos` singleton. A stale-response guard drops an out-of-order fetch so fast typing
 * can't leave older matches showing.
 */
export function useRepoSearch(fetcher?: RepoFetcher) {
  const github = useGitHubStore()
  const doFetch: RepoFetcher = fetcher ?? ((q) => github.searchAvailableRepos(q))

  const search = ref('')
  const debounced = refDebounced(search, 250)
  // Trimmed for the min-length gate; the backend matches case-insensitively.
  const query = computed(() => debounced.value.trim())
  const belowMinChars = computed(() => query.value.length < REPO_SEARCH_MIN_LEN)

  const results = ref<GitHubAvailableRepo[]>([])
  const loading = ref(false)
  // Monotonic token so a slow earlier fetch can't overwrite a faster later one.
  let seq = 0

  watch(query, async (q) => {
    if (q.length < REPO_SEARCH_MIN_LEN) {
      results.value = []
      return
    }
    const mine = ++seq
    loading.value = true
    try {
      const found = await doFetch(q)
      if (mine === seq) results.value = found
    } finally {
      if (mine === seq) loading.value = false
    }
  })

  /** Clear the search term and results (e.g. after a pick, or when the host closes). */
  function reset() {
    search.value = ''
    results.value = []
    // Bump the token so an in-flight fetch's result/finally is ignored — and clear `loading`
    // ourselves, since that same in-flight `finally` will now skip its `mine === seq` guard and
    // would otherwise leave the spinner stuck on until the next search completes.
    seq++
    loading.value = false
  }

  return { search, query, belowMinChars, results, loading, reset }
}
