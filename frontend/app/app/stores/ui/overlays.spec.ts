import { describe, it, expect } from 'vitest'
import { createUiModals } from '~/stores/ui/modals'

/**
 * The consumer-overlay host slice (extension slice D — the frontend-extension-mechanism
 * initiative). It is composed into `createUiModals`, so these tests drive it there directly
 * (plain refs/functions, no Pinia). The pointer is pick-one: opening a second overlay replaces
 * the first, and closing clears it — this is what `<AppOverlayHost>` reads to mount exactly one
 * consumer overlay.
 */
describe('ui overlay host (slice D)', () => {
  it('starts with no active overlay', () => {
    const ui = createUiModals()
    expect(ui.activeOverlay.value).toBeNull()
  })

  it('openOverlay sets the active id + subject; closeOverlay clears it', () => {
    const ui = createUiModals()
    ui.openOverlay('acme:security-dashboard-overlay', { blockId: 'blk_1' })
    expect(ui.activeOverlay.value).toEqual({
      id: 'acme:security-dashboard-overlay',
      subject: { blockId: 'blk_1' },
    })
    ui.closeOverlay()
    expect(ui.activeOverlay.value).toBeNull()
  })

  it('openOverlay without a subject leaves subject undefined', () => {
    const ui = createUiModals()
    ui.openOverlay('acme:security-dashboard-overlay')
    expect(ui.activeOverlay.value).toEqual({
      id: 'acme:security-dashboard-overlay',
      subject: undefined,
    })
  })

  it('is pick-one — opening a second overlay replaces the first', () => {
    const ui = createUiModals()
    ui.openOverlay('acme:one')
    ui.openOverlay('acme:two', 42)
    expect(ui.activeOverlay.value).toEqual({ id: 'acme:two', subject: 42 })
  })
})
