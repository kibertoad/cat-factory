import { defineStore } from 'pinia'
import { ref } from 'vue'
import { lodAtLeast } from '~/composables/useSemanticZoom'
import { useUiStore } from '~/stores/ui'

/**
 * Which task cards render their full build-pipeline list.
 *
 * Past the `steps` band, every on-screen card expands. Deep-zoom grows a card downward, so
 * the board driver (`useTaskExpansion`) denies whichever card would collide with one nearer
 * the screen centre and writes the survivors here. The render (`TaskPipelineMini`) and the
 * stacking (`LaneTask`) both read `isExpanded`, so they can never disagree.
 *
 * Hovering a card does NOT expand it. It used to, and an expanded card in a lane pushes the
 * cards below it down, so the pointer arriving on one card moved the buttons of its
 * neighbours and a click landed on the wrong element (UXA-01). The step a run is on now
 * shows on every in-flight card at every zoom, in `TaskProgressRow`.
 *
 * `driverActive` lets the grant degrade gracefully: with no board driver mounted (e.g. a
 * card rendered in isolation) it falls back to "allowed", so the plain zoom behaviour is
 * unchanged.
 */
export const useTaskExpansionStore = defineStore('taskExpansion', () => {
  const ui = useUiStore()
  const allowed = ref<Set<string>>(new Set())
  const driverActive = ref(false)

  function setAllowed(ids: Set<string>) {
    allowed.value = ids
  }

  function setDriverActive(active: boolean) {
    driverActive.value = active
    if (!active) allowed.value = new Set()
  }

  /** Whether this task card should render its pipeline: granted by the deep-zoom bands. */
  function isExpanded(id: string) {
    if (!lodAtLeast(ui.lod, 'steps')) return false
    return driverActive.value ? allowed.value.has(id) : true
  }

  return { allowed, driverActive, setAllowed, setDriverActive, isExpanded }
})
