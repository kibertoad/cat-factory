import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Which service frames may auto-expand to reveal their tasks once zoomed in.
 *
 * Past the `close` band a frame opens from a chip to its full task canvas, which
 * can balloon across the viewport. Expanding *every* frame at once (the old
 * behaviour) made a large off-centre service "snap out" over the small one the
 * user was actually centred on, and expanded services that weren't even on screen.
 * The board driver (`useFrameExpansion`) recomputes a permitted set every frame —
 * only on-screen frames, and only the one closest to the screen centre when two
 * expanded footprints would overlap — and writes it here. `ui.isFrameExpanded`
 * reads `canExpand` to decide whether the zoom band may open a frame.
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
