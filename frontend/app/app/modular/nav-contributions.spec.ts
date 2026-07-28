import { describe, expect, it } from 'vitest'
import enCatalog from '../../i18n/locales/en.json'
import {
  groupCommands,
  groupSidebar,
  NAV_ACTIONS,
  NAV_CONTRIBUTIONS,
  navSlotFilter,
  sortToolbar,
} from './nav-contributions'
import type { AppSlots, NavGates } from './nav-contributions'

/** The layer's base i18n catalog, used to prove every referenced key resolves. */
const en = enCatalog as Record<string, unknown>

/** Walk a dotted vue-i18n key path; true when it resolves to a leaf string. */
function hasKey(path: string): boolean {
  let node: unknown = en
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

const NO_GATES: NavGates = {
  canWriteBoard: false,
  canManageIntegrations: false,
  canManageSettings: false,
  githubAvailable: false,
  libraryAvailable: false,
  infrastructureAvailable: false,
  accountsEnabled: false,
  isAccountAdmin: false,
  // The permission axis is what these cases vary; keep the interface tier at `advanced`
  // so a dropped item is unambiguously an RBAC/availability drop, not a tier drop.
  advancedMode: true,
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
  advancedMode: true,
}

const slots = (): AppSlots => ({
  nav: [...NAV_CONTRIBUTIONS],
  resultViews: [],
  agentKinds: [],
  inspectorPanels: [],
  taskTypes: [],
  taskTypeFormPanels: [],
  appOverlays: [],
})
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

  it('drops every advanced destination in basic interface mode', () => {
    const gates: NavGates = { ...ALL_GATES, advancedMode: false }
    const kept = ids(navSlotFilter(slots(), { gates }))
    const basicOnly = NAV_CONTRIBUTIONS.filter((i) => !i.advanced).map((i) => i.id)
    expect(kept.sort()).toEqual(basicOnly.sort())
    // The everyday surface survives...
    expect(kept).toContain('add-from-repo')
    expect(kept).toContain('integrations-hub')
    expect(kept).toContain('workspace-settings')
    expect(kept).toContain('model-config')
    // ...and the authoring / operator surfaces don't.
    expect(kept).not.toContain('build-pipeline')
    expect(kept).not.toContain('fragments')
    expect(kept).not.toContain('sandbox')
    expect(kept).not.toContain('operator-dashboard')
  })

  it('keeps the tier and the permission axes independent — both must pass', () => {
    // `build-pipeline` is advanced AND needs board.write: neither axis alone reveals it.
    const advancedOnly: NavGates = { ...NO_GATES, advancedMode: true }
    expect(ids(navSlotFilter(slots(), { gates: advancedOnly }))).not.toContain('build-pipeline')

    const permissionOnly: NavGates = { ...NO_GATES, canWriteBoard: true, advancedMode: false }
    expect(ids(navSlotFilter(slots(), { gates: permissionOnly }))).not.toContain('build-pipeline')

    const both: NavGates = { ...NO_GATES, canWriteBoard: true, advancedMode: true }
    expect(ids(navSlotFilter(slots(), { gates: both }))).toContain('build-pipeline')
  })

  it('leaves at least one sidebar destination in every basic-mode section it keeps', () => {
    // A section whose every item is advanced is dropped wholesale upstream (groupSidebar drops
    // empties), which is intended — but a basic-mode sidebar with NO destinations at all would
    // be a broken shell, so pin that the everyday surface is non-empty.
    const gates: NavGates = { ...ALL_GATES, advancedMode: false }
    const kept = (navSlotFilter(slots(), { gates }) as AppSlots).nav
    const groups = groupSidebar(kept)
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0)
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

  it('every first-party action id is a known NAV_ACTION (no dead buttons)', () => {
    // `useNavContributions` resolves an `action` against an exhaustive
    // `Record<NavActionId, …>` handler map, so a catalog action outside
    // NAV_ACTIONS would be a dead button. The type system already enforces this;
    // this asserts it at runtime too (and that NAV_ACTIONS has no stale ids).
    const declared = new Set<string>(NAV_ACTIONS)
    const used = new Set<string>()
    for (const item of NAV_CONTRIBUTIONS) {
      if (!item.action) continue
      used.add(item.action)
      expect(declared.has(item.action), `${item.id} → unknown action ${item.action}`).toBe(true)
    }
    // No NAV_ACTION is orphaned (every declared handler id is actually used).
    for (const action of NAV_ACTIONS) {
      expect(used.has(action), `NAV_ACTION ${action} is unused`).toBe(true)
    }
  })

  it('every referenced i18n key exists in the en catalog (no raw-key leak)', () => {
    const missing: string[] = []
    const check = (key: string | undefined) => {
      if (key && !hasKey(key)) missing.push(key)
    }
    for (const group of ['create', 'repositories', 'integrations', 'workspace', 'account']) {
      check(`layout.commandBar.groups.${group}`)
    }
    for (const group of [
      'create',
      'repositories',
      'integrations',
      'infrastructure',
      'workspaceContext',
      'configuration',
    ]) {
      check(`nav.${group}`)
    }
    for (const item of NAV_CONTRIBUTIONS) {
      check(item.labelKey)
      if (item.command) {
        // Palette label falls back to the item's default labelKey.
        check(item.command.labelKey ?? item.labelKey)
        check(item.command.keywordsKey)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('nav grouping helpers', () => {
  it('groupSidebar orders sections + items and drops empty sections', () => {
    const groups = groupSidebar(NAV_CONTRIBUTIONS)
    expect(groups.map((g) => g.group)).toEqual([
      'create',
      'repositories',
      'integrations',
      'infrastructure',
      'workspaceContext',
      'configuration',
    ])
    const configuration = groups.find((g) => g.group === 'configuration')
    expect(configuration?.items.map((i) => i.id)).toEqual([
      'workspace-settings',
      'model-config',
      'account-settings',
      'operator-dashboard',
      'reports',
    ])
  })

  it('groupCommands preserves the pre-slice-1 workspace-group order', () => {
    const workspace = groupCommands(NAV_CONTRIBUTIONS).find((g) => g.group === 'workspace')
    // Same order the old CommandBar pushed them in (parity, not a reorder).
    expect(workspace?.items.map((ci) => ci.item.id)).toEqual([
      'fragments',
      'merge-thresholds',
      'workspace-settings',
      'model-config',
      'service-fragment-defaults',
      'local-models',
      'sandbox',
      'keyboard-shortcuts',
    ])
  })

  it('sortToolbar yields nothing first-party (consumer-only extension point)', () => {
    expect(sortToolbar(NAV_CONTRIBUTIONS)).toEqual([])
  })
})
