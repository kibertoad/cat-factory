import { describe, expect, it } from 'vitest'
import { NAV_CONTRIBUTIONS, navSlotFilter } from './nav-contributions'
import type { AppSlots, NavGates } from './nav-contributions'

const NO_GATES: NavGates = {
  canWriteBoard: false,
  canManageIntegrations: false,
  canManageSettings: false,
  githubAvailable: false,
  libraryAvailable: false,
  infrastructureAvailable: false,
  accountsEnabled: false,
  isAccountAdmin: false,
}

const ALL_GATES: NavGates = {
  canWriteBoard: true,
  canManageIntegrations: true,
  canManageSettings: true,
  githubAvailable: true,
  libraryAvailable: true,
  infrastructureAvailable: true,
  accountsEnabled: true,
  isAccountAdmin: true,
}

const slots = (): AppSlots => ({ nav: [...NAV_CONTRIBUTIONS] })
const ids = (s: unknown) => (s as AppSlots).nav.map((i) => i.id)

describe('navSlotFilter', () => {
  it('drops every gated item when no permission/availability is granted', () => {
    const kept = ids(navSlotFilter(slots(), { gates: NO_GATES }))
    // Only the always-visible destinations survive (no `gate`).
    const alwaysVisible = NAV_CONTRIBUTIONS.filter((i) => !i.gate).map((i) => i.id)
    expect(kept.sort()).toEqual(alwaysVisible.sort())
    expect(kept).toContain('kaizen')
    expect(kept).not.toContain('build-pipeline')
    expect(kept).not.toContain('operator-dashboard')
  })

  it('keeps every item when all gates pass', () => {
    const kept = ids(navSlotFilter(slots(), { gates: ALL_GATES }))
    expect(kept.sort()).toEqual(NAV_CONTRIBUTIONS.map((i) => i.id).sort())
  })

  it('reflects a single permission — board.write reveals only its items', () => {
    const gates: NavGates = { ...NO_GATES, canWriteBoard: true, githubAvailable: true }
    const kept = ids(navSlotFilter(slots(), { gates }))
    expect(kept).toContain('build-pipeline')
    expect(kept).toContain('add-from-repo') // needs github + board.write
    expect(kept).not.toContain('bootstrap-repo') // needs integrations.manage
  })

  it('passes everything through when no gates service is wired (dev-open parity)', () => {
    const kept = ids(navSlotFilter(slots(), {}))
    expect(kept.sort()).toEqual(NAV_CONTRIBUTIONS.map((i) => i.id).sort())
  })
})

describe('NAV_CONTRIBUTIONS catalog integrity', () => {
  it('has unique ids and every item targets at least one surface', () => {
    const seen = new Set<string>()
    for (const item of NAV_CONTRIBUTIONS) {
      expect(seen.has(item.id), `duplicate id ${item.id}`).toBe(false)
      seen.add(item.id)
      expect(item.surfaces.length, `${item.id} has no surface`).toBeGreaterThan(0)
      // Every surface it targets must carry that surface's placement.
      if (item.surfaces.includes('sidebar')) expect(item.sidebar, `${item.id} sidebar`).toBeTruthy()
      if (item.surfaces.includes('command')) expect(item.command, `${item.id} command`).toBeTruthy()
      // A first-party item is actionable (an id resolved host-side, or a run closure).
      expect(item.action ?? item.run, `${item.id} has no action`).toBeTruthy()
    }
  })
})
