import { ref } from 'vue'

// Service frames can overlap freely on the board. The frame the pointer is over
// is, by definition, the un-obscured one at that point (pointerenter fires on the
// topmost element), so we track it and lift it above every overlapping neighbour.
// Module-level singleton: BlockNode sets it on hover, BoardCanvas reads it to set
// the Vue Flow node's z-index.
const hoveredFrameId = ref<string | null>(null)

export function useFrameStacking() {
  function enter(id: string) {
    hoveredFrameId.value = id
  }
  function leave(id: string) {
    if (hoveredFrameId.value === id) hoveredFrameId.value = null
  }
  return { hoveredFrameId, enter, leave }
}
