import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Which task cards may expand their full build-pipeline list once zoomed in.
 *
 * Deep-zoom (`steps`/`subtasks`) grows a task card downward, and cards are
 * absolutely positioned in their frame, so several expanded cards stacked
 * vertically pile on top of each other. The board driver (`useTaskExpansion`)
 * recomputes a permitted set every frame — only on-screen cards, and only the
 * one closest to the screen centre when two would overlap — and writes it here.
 * `TaskPipelineMini` reads `canExpand` to decide whether to expand or stay compact.
 *
 * `driverActive` lets the gate degrade gracefully: with no board driver mounted
 * (e.g. a card rendered in isolation) `canExpand` falls back to "allowed", so the
 * plain zoom behaviour is unchanged.
 */
export const useTaskExpansionStore = defineStore('taskExpansion', () => {
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
