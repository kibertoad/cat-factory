import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DEFAULT_WORK_VIEW, isWorkView, WORK_VIEW_PARAM, type WorkView } from '~/utils/workView'

/**
 * Which view of the board this person is looking at: the queue or the canvas.
 *
 * Persisted per BROWSER in a cookie, like the interface tier and the lane order: it is the view
 * used LAST in this browser, so a person who prefers the canvas stays on it, and nobody on another
 * browser is moved by their choice. See `utils/workView.ts` for why the queue is the default.
 */
export const useWorkViewStore = defineStore(
  'workView',
  () => {
    // Stored raw and narrowed on read, as `uiMode` does: the persisted value is untrusted input.
    const storedView = ref<string>(DEFAULT_WORK_VIEW)
    const view = computed<WorkView>(() =>
      isWorkView(storedView.value) ? storedView.value : DEFAULT_WORK_VIEW,
    )

    function show(next: WorkView) {
      storedView.value = next
    }

    /**
     * Honour a `?view=queue` / `?view=board` link, then strip the parameter so a reload or a
     * copied URL does not re-apply it over a later choice. Same shape as the run deep link. A
     * `view` value that names no view is dropped without effect, rather than guessed onto one.
     */
    function consumeDeepLink() {
      if (!import.meta.client) return
      const url = new URL(window.location.href)
      if (!url.searchParams.has(WORK_VIEW_PARAM)) return
      const asked = url.searchParams.get(WORK_VIEW_PARAM)
      url.searchParams.delete(WORK_VIEW_PARAM)
      window.history.replaceState(window.history.state, '', url.toString())
      if (isWorkView(asked)) show(asked)
    }

    return { storedView, view, show, consumeDeepLink }
  },
  { persist: { pick: ['storedView'] } },
)
