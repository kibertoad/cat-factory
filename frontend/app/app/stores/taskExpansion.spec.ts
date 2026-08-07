import { describe, it, expect } from 'vitest'
import { useTaskExpansionStore } from '~/stores/taskExpansion'
import { useUiStore } from '~/stores/ui'

/**
 * The expansion gate combines two independent grants (hover at any zoom, the deep zoom
 * bands otherwise). Both `TaskPipelineMini` (what renders) and `LaneTask` (what
 * stacks on top) read `isExpanded`, so these cases pin the rule they share.
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

describe('taskExpansion — hover expands at any zoom level', () => {
  it('expands the hovered card while zoomed out past the steps band', () => {
    const store = setup(0.5) // `far`
    store.setHovered('task-a')
    expect(store.isExpanded('task-a')).toBe(true)
    // Hover is a grant of ONE card: its neighbours stay compact at this zoom.
    expect(store.isExpanded('task-b')).toBe(false)
  })

  it('expands the hovered card at every band, not just the shallow ones', () => {
    const store = setup(1) // `mid`
    store.setHovered('task-a')
    expect(store.isExpanded('task-a')).toBe(true)
    useUiStore().zoom = 1.5 // `close`
    expect(store.isExpanded('task-a')).toBe(true)
    useUiStore().zoom = 3 // `subtasks`
    expect(store.isExpanded('task-a')).toBe(true)
  })

  it('collapses again once the pointer leaves the card', () => {
    const store = setup(0.5)
    store.setHovered('task-a')
    store.setHovered(null)
    expect(store.isExpanded('task-a')).toBe(false)
  })

  it('expands a hovered card the zoom gate denied for overlapping a neighbour', () => {
    const store = setup(2) // `steps`
    store.setAllowed(new Set(['task-b']))
    store.setHovered('task-a')
    expect(store.isExpanded('task-a')).toBe(true)
    expect(store.isExpanded('task-b')).toBe(true)
  })
})

describe('taskExpansion — the zoom grant is unchanged', () => {
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

  it('drops both grants when the driver unmounts', () => {
    const store = setup(2)
    store.setAllowed(new Set(['task-a']))
    store.setHovered('task-b')
    store.setDriverActive(false)
    expect(store.allowed.size).toBe(0)
    expect(store.hoveredId).toBeNull()
  })
})
