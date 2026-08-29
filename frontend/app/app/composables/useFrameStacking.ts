import { ref } from 'vue'

// Service frames are kept clear of one another (see useFrameOverlapGuard), but their boxes are
// not all there is to stack: chrome hangs outside the box, a drag crosses a neighbour before the
// guard has bounced it, and Vue Flow needs SOME order regardless. The frame the pointer is over
// is, by definition, the un-obscured one at that point (pointerenter fires on the topmost
// element), so we track it and lift it above its neighbours. Module-level singleton: BlockNode
// sets it on hover, BoardCanvas reads it to set the Vue Flow node's z-index.
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
