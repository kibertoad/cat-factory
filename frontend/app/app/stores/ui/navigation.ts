import { computed, ref } from 'vue'
import type { LodLevel } from '~/types/domain'
import { zoomToLod } from '~/composables/useSemanticZoom'

/**
 * The board-navigation slice of the UI store: selection / focus, and canvas zoom plus the derived
 * level-of-detail. Hot paths (zoom/pan/select) live here, isolated from the modal + result-view
 * state, per refactoring candidate #4. Composed into {@link useUiStore}; the returned refs/actions
 * keep their names, so consumers are unchanged.
 *
 * There is deliberately no per-frame expanded/collapsed state: a service is always expanded to its
 * task canvas, at every zoom level, so the board layout is fixed. The set that used to hold it
 * outlived the last branch that read it and went with them.
 */
export function createUiNavigation() {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)

  /** Current canvas zoom (driven by Vue Flow viewport). */
  const zoom = ref(1)

  const lod = computed<LodLevel>(() => zoomToLod(zoom.value))

  function select(id: string | null) {
    selectedBlockId.value = id
  }

  function focus(id: string | null) {
    focusBlockId.value = id
  }

  return {
    selectedBlockId,
    focusBlockId,
    zoom,
    lod,
    select,
    focus,
  }
}
