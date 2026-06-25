import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Which service frames may auto-expand to reveal their tasks once zoomed in.
 *
 * Past the `close` band a frame opens from a chip to its full task canvas, which
 * can balloon across the viewport. The board driver (`useFrameExpansion`) recomputes
 * a permitted set every frame — every frame currently on screen — and writes it here;
 * `ui.isFrameExpanded` reads `canExpand` to decide whether the zoom band may open a
 * frame. Off-screen frames are excluded so zooming in doesn't expand services you
 * can't see. The canvas reserves room for each expanded frame by pushing its
 * neighbours away (compressed space), so expanded footprints never overlap and no
 * frame has to collapse to make room for another.
 *
 * `driverActive` lets the gate degrade gracefully: with no board driver mounted
 * (e.g. the focus view, or a frame rendered in isolation / tests) `canExpand`
 * falls back to "allowed", so the plain zoom behaviour is unchanged.
 */
export const useFrameExpansionStore = defineStore('frameExpansion', () => {
  const allowed = ref<Set<string>>(new Set())
  const driverActive = ref(false)

  function setAllowed(ids: Set<string>) {
    allowed.value = ids
  }

  function setDriverActive(active: boolean) {
    driverActive.value = active
    if (!active) allowed.value = new Set()
  }

  function canExpand(id: string) {
    return driverActive.value ? allowed.value.has(id) : true
  }

  return { allowed, driverActive, setAllowed, setDriverActive, canExpand }
})
