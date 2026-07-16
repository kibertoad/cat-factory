import { computed, ref } from 'vue'
import type { LodLevel } from '~/types/domain'
import { zoomToLod } from '~/composables/useSemanticZoom'

/**
 * The board-navigation slice of the UI store: selection / focus, canvas zoom + the derived
 * level-of-detail, and the (retained) expanded-frame set. Hot paths (zoom/pan/select) live here,
 * isolated from the modal + result-view state, per refactoring candidate #4. Composed into
 * {@link useUiStore}; the returned refs/actions keep their names, so consumers are unchanged.
 */
export function createUiNavigation() {
  const selectedBlockId = ref<string | null>(null)
  const focusBlockId = ref<string | null>(null)

  /** Current canvas zoom (driven by Vue Flow viewport). */
  const zoom = ref(1)

  const lod = computed<LodLevel>(() => zoomToLod(zoom.value))

  /** Frames the user has manually expanded to reveal their tasks. */
  const expandedFrames = ref<Set<string>>(new Set())

  function toggleFrame(id: string) {
    const next = new Set(expandedFrames.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expandedFrames.value = next
  }

  function expandFrame(id: string) {
    if (expandedFrames.value.has(id)) return
    expandedFrames.value = new Set(expandedFrames.value).add(id)
  }

  /** Services are always expanded to their task canvas, at every zoom level, so the
   * board layout is fixed: panning never changes it and zooming has no expand/collapse
   * transition to snap on. (`expandedFrames`/`toggleFrame` are retained for callers but
   * no longer gate rendering.) */
  function isFrameExpanded(_id: string) {
    return true
  }

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
    expandedFrames,
    toggleFrame,
    expandFrame,
    isFrameExpanded,
    select,
    focus,
  }
}
