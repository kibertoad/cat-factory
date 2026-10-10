import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_HOME_VIEW,
  HOME_PREVIEW_PARAM,
  isHomeView,
  parsePreviewParam,
  type HomeView,
} from '~/utils/homePreview'

/**
 * The queue-first preview switch, the view it is showing, and the intake dialog it adds.
 *
 * Per USER and per BROWSER, persisted like the interface tier: trying a second shell is a
 * personal choice, and one person's preview must not rearrange a teammate's board. Only
 * `enabled` is persisted. The VIEW is not: the claim the preview tests is that the queue is
 * the home, so every load lands there, exactly as the canvas is the home today.
 *
 * See `utils/homePreview.ts` for what the preview replaces and why it is off by default.
 */
export const useHomePreviewStore = defineStore(
  'homePreview',
  () => {
    const enabled = ref(false)
    const storedView = ref<string>(DEFAULT_HOME_VIEW)

    /**
     * The view the main area shows. Always `board` while the preview is off, so a reader of
     * this value never has to restate the switch.
     */
    const view = computed<HomeView>(() => {
      if (!enabled.value) return 'board'
      return isHomeView(storedView.value) ? storedView.value : DEFAULT_HOME_VIEW
    })

    function setEnabled(next: boolean) {
      enabled.value = next
      storedView.value = DEFAULT_HOME_VIEW
      if (!next) closeDescribeWork()
    }

    function show(next: HomeView) {
      storedView.value = next
    }

    /**
     * Honour a `?preview=queue` / `?preview=off` link, then strip the parameter so a reload or a
     * copied URL does not re-apply it over a later choice. Same shape as the run deep link.
     */
    function consumeDeepLink() {
      if (!import.meta.client) return
      const url = new URL(window.location.href)
      const asked = parsePreviewParam(url.searchParams.get(HOME_PREVIEW_PARAM))
      if (!url.searchParams.has(HOME_PREVIEW_PARAM)) return
      url.searchParams.delete(HOME_PREVIEW_PARAM)
      window.history.replaceState(window.history.state, '', url.toString())
      if (asked !== null) setEnabled(asked)
    }

    // ---- sentence-first intake ---------------------------------------------
    /** Whether the "Describe new work" dialog is open. */
    const describeWorkOpen = ref(false)
    /** The service the dialog opened on, or null to let the reader pick one. */
    const describeWorkServiceId = ref<string | null>(null)

    function openDescribeWork(serviceId: string | null = null) {
      describeWorkServiceId.value = serviceId
      describeWorkOpen.value = true
    }

    function closeDescribeWork() {
      describeWorkOpen.value = false
    }

    return {
      enabled,
      storedView,
      view,
      setEnabled,
      show,
      consumeDeepLink,
      describeWorkOpen,
      describeWorkServiceId,
      openDescribeWork,
      closeDescribeWork,
    }
  },
  { persist: { pick: ['enabled'] } },
)
