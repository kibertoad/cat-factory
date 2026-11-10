import { describe, it, expect } from 'vitest'
import { useTaskExpansionStore } from '~/stores/taskExpansion'
import { useUiStore } from '~/stores/ui'

/**
 * The expansion gate is the deep zoom bands' grant, and nothing else: hovering a card does
 * not expand it (UXA-01). Both `TaskPipelineMini` (what renders) and `LaneTask` (what stacks
 * on top) read `isExpanded`, so these cases pin the rule they share.
 *
 * Zoom is set through the ui store's raw `zoom`, the same value the board canvas writes;
 * `lod` derives from it (< 1.8 is shallower than the `steps` band).
 */
function setup(zoom: number) {
  const ui = useUiStore()
  ui.zoom = zoom
  const store = useTaskExpansionStore()
  store.setDriverActive(true)
  return store
}

describe('taskExpansion — the zoom grant', () => {
  it('honours the driver grant only from the steps band up', () => {
    const store = setup(1.5) // `close` — one band shallower than `steps`
    store.setAllowed(new Set(['task-a']))
    expect(store.isExpanded('task-a')).toBe(false)
    useUiStore().zoom = 2 // `steps`
    expect(store.isExpanded('task-a')).toBe(true)
  })

  it('denies a card the driver left out of the permitted set', () => {
    const store = setup(2)
    store.setAllowed(new Set(['task-b']))
    expect(store.isExpanded('task-a')).toBe(false)
  })

  it('falls back to allowed with no driver mounted, still only at the deep bands', () => {
    const ui = useUiStore()
    ui.zoom = 2
    const store = useTaskExpansionStore() // driverActive stays false
    expect(store.isExpanded('task-a')).toBe(true)
    ui.zoom = 1
    expect(store.isExpanded('task-a')).toBe(false)
  })

  it('drops the grant when the driver unmounts', () => {
    const store = setup(2)
    store.setAllowed(new Set(['task-a']))
    store.setDriverActive(false)
    expect(store.allowed.size).toBe(0)
  })
})
