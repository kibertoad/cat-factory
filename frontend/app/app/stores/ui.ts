import { defineStore } from 'pinia'
import { createUiNavigation } from '~/stores/ui/navigation'
import { createUiResultViews } from '~/stores/ui/resultViews'
import { createUiModals } from '~/stores/ui/modals'

export type { AddTaskPrefill, K3sSetupPrefill } from '~/stores/ui/modals'

/**
 * Transient UI state: selection, panels, zoom level.
 *
 * The concerns are split into cohesive, independently-testable slices under `stores/ui/`
 * (refactoring candidate #4 — the store had grown to 40+ unrelated concerns in one 800-line
 * file): board `navigation` (selection / focus / zoom / LOD), the step `resultViews` overlay
 * seam (`dispatchStepView` / `ui.resultView` + the observability + Kaizen panels), and the
 * `modals` slice (every modal / panel open-close flag, hub markers, deep-link params, and the
 * startup + AI-onboarding advisories). This store composes them behind ONE unchanged public
 * surface, so every existing `useUiStore()` consumer is untouched — the split is internal.
 */
export const useUiStore = defineStore('ui', () => {
  const navigation = createUiNavigation()
  const resultViews = createUiResultViews()
  const modals = createUiModals()

  return {
    ...navigation,
    ...resultViews,
    ...modals,
  }
})
