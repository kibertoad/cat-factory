import { defineStore } from 'pinia'
import { ref } from 'vue'
import { lodAtLeast } from '~/composables/useSemanticZoom'
import { useUiStore } from '~/stores/ui'

/**
 * Which task cards render their full build-pipeline list.
 *
 * Two independent grants, both written every frame by the board driver
 * (`useTaskExpansion`) and combined HERE so the render (`TaskPipelineMini`) and the
 * stacking (`LaneTask`) can never disagree about which cards are expanded:
 *
 *  - HOVER — the card under the pointer expands at ANY zoom level. Pointing at a task
 *    is asking what it is doing right now, and that answer used to be reachable only
 *    by first zooming past the `steps` band.
 *  - ZOOM — past the `steps` band, every on-screen card expands. Deep-zoom grows a card
 *    downward and cards are absolutely positioned in their frame, so several expanded
 *    cards stacked vertically pile on top of each other; the driver denies whichever
 *    would collide with a card nearer the screen centre and writes the survivors here.
 *
 * `driverActive` lets the zoom grant degrade gracefully: with no board driver mounted
 * (e.g. a card rendered in isolation) it falls back to "allowed", so the plain zoom
 * behaviour is unchanged. The hover grant needs no fallback — without the driver
 * nothing is hovered.
 */
export const useTaskExpansionStore = defineStore('taskExpansion', () => {
  const ui = useUiStore()
  const allowed = ref<Set<string>>(new Set())
  const hoveredId = ref<string | null>(null)
  const driverActive = ref(false)

  function setAllowed(ids: Set<string>) {
    allowed.value = ids
  }

  function setHovered(id: string | null) {
    hoveredId.value = id
  }

  function setDriverActive(active: boolean) {
    driverActive.value = active
    if (!active) {
      allowed.value = new Set()
      hoveredId.value = null
    }
  }

  /** Whether this task card should render its pipeline: hovered at any zoom, else
   *  granted by the deep-zoom bands. */
  function isExpanded(id: string) {
    if (hoveredId.value === id) return true
    if (!lodAtLeast(ui.lod, 'steps')) return false
    return driverActive.value ? allowed.value.has(id) : true
  }

  return { allowed, hoveredId, driverActive, setAllowed, setHovered, setDriverActive, isExpanded }
})
