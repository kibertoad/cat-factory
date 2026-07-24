import { describe, it, expect } from 'vitest'
import { selectOverlay } from './AppOverlayHost.logic'
import type { OverlayContribution } from '~/modular/slots'

/**
 * The pure selection behind `<AppOverlayHost>` (extension slice D — the frontend-extension-mechanism
 * initiative). Pins the resilience the seam advertises: a matching id mounts its component, a
 * dangling open (no registered component) degrades to nothing (`missing: true`, the host's dev-warn
 * signal), no open renders nothing, and duplicate ids fail fast (the boot guard's contract).
 */
// A plain object stands in for the SFC — `selectOverlay` only ever keys by id.
const overlay = (id: string): OverlayContribution => ({ id, component: { name: id } as never })

describe('selectOverlay (AppOverlayHost slice D)', () => {
  it('returns nothing when no overlay is open (null / undefined id)', () => {
    const overlays = [overlay('acme:security-dashboard-overlay')]
    expect(selectOverlay(overlays, null)).toEqual({ component: null, missing: false })
    expect(selectOverlay(overlays, undefined)).toEqual({ component: null, missing: false })
  })

  it('picks the component whose id matches the active overlay', () => {
    const entry = overlay('acme:security-dashboard-overlay')
    const { component, missing } = selectOverlay([entry], 'acme:security-dashboard-overlay')
    expect(component).toBe(entry.component)
    expect(missing).toBe(false)
  })

  it('degrades a dangling open to nothing and flags it missing (no crash)', () => {
    const { component, missing } = selectOverlay([overlay('acme:one')], 'acme:gone')
    expect(component).toBeNull()
    expect(missing).toBe(true)
  })

  it('fails fast on duplicate overlay ids (the boot guard contract)', () => {
    const dupes = [overlay('acme:dup'), overlay('acme:dup')]
    expect(() => selectOverlay(dupes, 'acme:dup')).toThrow()
  })
})
