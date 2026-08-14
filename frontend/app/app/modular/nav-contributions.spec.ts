import { describe, expect, it } from 'vitest'
import { hasI18nKey } from '../../test/i18nKeys'
import {
  COMMAND_GROUP_ORDER,
  groupCommands,
  groupSidebar,
  NAV_ACTIONS,
  NAV_CONTRIBUTIONS,
  navSlotFilter,
  SIDEBAR_GROUP_ORDER,
  sortToolbar,
} from './nav-contributions'
import type { AppSlots, NavGatedContribution, NavGates } from './nav-contributions'
import type { ExternalToolContribution } from './external-tools'

/** Prove every referenced key resolves in the layer's base catalog (see `test/i18nKeys`). */
const hasKey = hasI18nKey

const NO_GATES: NavGates = {
  canWriteBoard: false,
  canManageIntegrations: false,
  canManageSettings: false,
  githubAvailable: false,
  libraryAvailable: false,
  designSourceConnected: false,
  infrastructureAvailable: false,
  accountsEnabled: false,
  isAccountAdmin: false,
  // The permission axis is what these cases vary; keep the interface tier at `advanced` and the
  // role at the full surface, so a dropped item is unambiguously an RBAC/availability drop rather
  // than a tier or role drop.
  advancedMode: true,
  fullSurface: true,
  boardHasService: false,
  boardHasTask: false,
  boardHasRun: false,
  boardHasOpenDecision: false,
  boardHasPendingApproval: false,
  boardHasFinishedRun: false,
  boardHasFailedRun: false,
}

const ALL_GATES: NavGates = {
  canWriteBoard: true,
  canManageIntegrations: true,
  canManageSettings: true,
  githubAvailable: true,
  libraryAvailable: true,
  designSourceConnected: true,
  infrastructureAvailable: true,
  accountsEnabled: true,
  isAccountAdmin: true,
  advancedMode: true,
  fullSurface: true,
  boardHasService: true,
  boardHasTask: true,
  boardHasRun: true,
  boardHasOpenDecision: true,
  boardHasPendingApproval: true,
  boardHasFinishedRun: true,
  boardHasFailedRun: true,
}

const slots = (): AppSlots => ({
  nav: [...NAV_CONTRIBUTIONS],
  resultViews: [],
  agentKinds: [],
  inspectorPanels: [],
  taskTypes: [],
  taskTypeFormPanels: [],
  appOverlays: [],
  tutorialTours: [],
  externalTools: [],
  workspaceMetadataFields: [],
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
    // Model providers are NOT an integration: the split is what makes the engines findable.
    expect(kept).toContain('model-providers')
    // ...and so does everything the everyday delivery loop runs on, however deep it feels:
    // authoring a flow, the standards library, and the ephemeral-env/runner plumbing.
    expect(kept).toContain('build-pipeline')
    expect(kept).toContain('fragments')
    // Also the only route to the guided per-service Compose environment setup, which folded
    // into this window rather than staying a sibling nav entry.
    expect(kept).toContain('infrastructure')
    // What drops is either a shortcut basic mode reaches another way, or a capability
    // deliberately kept out of the tier (experimentation, one-off repo setup, the
    // deployment-wide operator rollups).
    expect(kept).not.toContain('sandbox')
    expect(kept).not.toContain('kaizen')
    expect(kept).not.toContain('merge-thresholds')
    expect(kept).not.toContain('bootstrap-repo')
    expect(kept).not.toContain('operator-dashboard')
    expect(kept).not.toContain('reports')
    expect(kept).not.toContain('foundational-services')
  })

  it('states, per advanced item, whether basic mode still reaches its capability', () => {
    // Marking an item `advanced` does one of two things, and which one has to be said out
    // loud. `reached-another-way` promises a basic destination opens the same surface, so
    // nothing is lost. `out-of-tier` concedes the opposite: the capability is ABSENT from
    // basic mode and the tier switch is the only way to it. Both are legitimate; a silent
    // one is not. The table is the claim, and it must match the catalog exactly, so adding
    // `advanced: true` fails here until the reason is written down.
    const REASON: Record<string, { kind: 'reached-another-way' | 'out-of-tier'; why: string }> = {
      'merge-thresholds': {
        kind: 'reached-another-way',
        why: 'workspace-settings -> Merge tab',
      },
      'service-fragment-defaults': {
        kind: 'reached-another-way',
        why: 'workspace-settings -> Service best practices tab',
      },
      'local-models': {
        kind: 'reached-another-way',
        why: 'model-providers -> My local runners',
      },
      sandbox: {
        kind: 'out-of-tier',
        why: 'experimentation surface, beside the delivery path',
      },
      kaizen: {
        kind: 'out-of-tier',
        why: 'self-grading history, beside the delivery path',
      },
      'bootstrap-repo': {
        kind: 'out-of-tier',
        why: 'one-off new-repo setup, not part of running work on an existing board',
      },
      'operator-dashboard': {
        kind: 'out-of-tier',
        why: 'deployment-wide health rollup - an operator job, not a delivery one',
      },
      reports: {
        kind: 'out-of-tier',
        why: 'deployment-wide spend/activity rollup - an operator job, not a delivery one',
      },
      'foundational-services': {
        kind: 'out-of-tier',
        why: 'org-wide platform inventory, set up once - a board delivers fine with none',
      },
    }
    const advanced = NAV_CONTRIBUTIONS.filter((i) => i.advanced).map((i) => i.id)
    expect(advanced.sort()).toEqual(Object.keys(REASON).sort())
    // An `out-of-tier` item is a real capability loss, so the switcher back must survive basic
    // mode — pinned by the next case. Assert here only that every claim carries a reason.
    for (const [id, reason] of Object.entries(REASON)) {
      expect(reason.why.length, `${id} has no stated reason`).toBeGreaterThan(0)
    }
  })

  it('drops every non-intake destination for a narrowed role', () => {
    const gates: NavGates = { ...ALL_GATES, fullSurface: false }
    const kept = ids(navSlotFilter(slots(), { gates }))
    const intakeOnly = NAV_CONTRIBUTIONS.filter((i) => i.intake).map((i) => i.id)
    expect(kept.sort()).toEqual(intakeOnly.sort())
    // Fully permitted and on the advanced tier, so every drop here is the ROLE and nothing else:
    // the platform configuration goes, and what teaches the product plus the way out stays.
    expect(kept).toContain('tutorial')
    expect(kept).toContain('ui-role')
    expect(kept).not.toContain('build-pipeline')
    expect(kept).not.toContain('add-from-repo')
    expect(kept).not.toContain('integrations-hub')
    expect(kept).not.toContain('workspace-settings')
    expect(kept).not.toContain('model-providers')
    expect(kept).not.toContain('account-settings')
    // A narrowed sidebar is short by design, but never a shell with nothing in it: the sidebar
    // is where the tutorials live, and `groupSidebar` drops an empty section upstream, so a
    // surface whose every item was palette-only would render as a broken navbar.
    const groups = groupSidebar((navSlotFilter(slots(), { gates }) as AppSlots).nav)
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0)
  })

  it('states, per intake item, why the narrowed role keeps it', () => {
    // The mirror of the advanced-item table above, and it earns its place for the opposite
    // reason: `intake` is opt-IN, so the risk is not a silent capability loss but a silent
    // WIDENING: one flag on a destination that configures the platform and the simplified
    // surface has quietly stopped being simple. The table is the claim; adding `intake: true`
    // fails here until the reason is written down.
    const REASON: Record<string, string> = {
      tutorial: 'the walkthroughs - the surface with the fewest destinations needs them most',
      'keyboard-shortcuts': 'the cheatsheet covers the board and the palette, which every role has',
      'ui-role': 'the way BACK out of the narrowed role',
    }
    const intake = NAV_CONTRIBUTIONS.filter((i) => i.intake).map((i) => i.id)
    expect(intake.sort()).toEqual(Object.keys(REASON).sort())
    for (const [id, why] of Object.entries(REASON)) {
      expect(why.length, `${id} has no stated reason`).toBeGreaterThan(0)
    }
  })

  it('keeps the role switch reachable from inside the narrowed role, and the tier switch out', () => {
    // The role decides which surfaces exist at all, so its own entry must survive the narrowing
    // it causes, or a designer who needs a pipeline has no route to say so.
    const roleItem = NAV_CONTRIBUTIONS.find((i) => i.id === 'ui-role')
    expect(roleItem?.intake).toBe(true)
    expect(roleItem?.gate).toBeUndefined()
    // The TIER toggle is deliberately the other way: a narrowed role's tier is capped at basic
    // (`resolveUiMode`), so an entry that flipped it would write a preference nothing honours.
    expect(NAV_CONTRIBUTIONS.find((i) => i.id === 'ui-mode')?.intake).toBeUndefined()

    const gates: NavGates = { ...NO_GATES, fullSurface: false }
    const kept = ids(navSlotFilter(slots(), { gates }))
    expect(kept).toContain('ui-role')
    expect(kept).not.toContain('ui-mode')
  })

  it('keeps the tier, role and permission axes independent, and all three must pass', () => {
    // `tutorial` is `intake` and ungated, `sandbox` is advanced + permissioned + not intake:
    // no single axis reveals the second, and narrowing the role cannot reveal anything.
    const narrowedButPermitted: NavGates = { ...ALL_GATES, fullSurface: false }
    expect(ids(navSlotFilter(slots(), { gates: narrowedButPermitted }))).not.toContain('sandbox')

    const fullButBasic: NavGates = { ...ALL_GATES, advancedMode: false }
    expect(ids(navSlotFilter(slots(), { gates: fullButBasic }))).not.toContain('sandbox')

    const fullButUnpermitted: NavGates = { ...NO_GATES, canManageIntegrations: false }
    expect(ids(navSlotFilter(slots(), { gates: fullButUnpermitted }))).not.toContain('sandbox')
  })

  it('keeps the tier switch itself reachable in basic mode', () => {
    // Basic is the shipped default, so this palette entry is how a user who never finds the
    // (icon-only, in the basic rail) sidebar switcher gets to the advanced half at all. Marking
    // it `advanced` would hide the way back from exactly the tier that needs it.
    const uiModeItem = NAV_CONTRIBUTIONS.find((i) => i.id === 'ui-mode')
    expect(uiModeItem?.advanced).toBeUndefined()
    expect(uiModeItem?.gate).toBeUndefined()

    const gates: NavGates = { ...NO_GATES, advancedMode: false }
    expect(ids(navSlotFilter(slots(), { gates }))).toContain('ui-mode')
  })

  it('keeps the tier and the permission axes independent — both must pass', () => {
    // `sandbox` is advanced AND needs integrations.manage: neither axis alone reveals it.
    const advancedOnly: NavGates = { ...NO_GATES, advancedMode: true }
    expect(ids(navSlotFilter(slots(), { gates: advancedOnly }))).not.toContain('sandbox')

    const permissionOnly: NavGates = {
      ...NO_GATES,
      canManageIntegrations: true,
      advancedMode: false,
    }
    expect(ids(navSlotFilter(slots(), { gates: permissionOnly }))).not.toContain('sandbox')

    const both: NavGates = { ...NO_GATES, canManageIntegrations: true, advancedMode: true }
    expect(ids(navSlotFilter(slots(), { gates: both }))).toContain('sandbox')
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

describe('navSlotFilter external tools', () => {
  const tool = (id: string, axes: NavGatedContribution = {}): ExternalToolContribution => ({
    id,
    title: id,
    icon: 'i-lucide-link',
    url: `https://${id}.dev`,
    ...axes,
  })
  const tools: ExternalToolContribution[] = [
    tool('acme:open'),
    tool('acme:permissioned', { gate: (g: NavGates) => g.canManageIntegrations }),
    tool('acme:power-user', { advanced: true }),
    tool('acme:intake', { intake: true }),
  ]
  const withTools = (): AppSlots => ({ ...slots(), externalTools: [...tools] })
  const toolIds = (s: unknown) => (s as AppSlots).externalTools.map((t) => t.id)

  it('gates registered tools in the SAME filter as the nav catalog', () => {
    // They become nav items downstream (`useNavContributions` projects them), so gating them
    // anywhere else would let a tool the caller can't use reach the palette while its sidebar
    // twin was correctly hidden.
    expect(toolIds(navSlotFilter(withTools(), { gates: ALL_GATES }))).toEqual(
      tools.map((t) => t.id),
    )
    expect(toolIds(navSlotFilter(withTools(), { gates: NO_GATES }))).toEqual([
      'acme:open',
      'acme:power-user',
      'acme:intake',
    ])
    // No gates service wired (tests, a bare install): everything passes, matching the dev-open
    // "absent access allows all" parity the nav half keeps.
    expect(toolIds(navSlotFilter(withTools(), {}))).toEqual(tools.map((t) => t.id))
  })

  it('drops a tool that has not opted into the intake surface', () => {
    // The axis a separate external-tools filter used to miss entirely: a `designer` kept the
    // deployment's whole External tools section while every first-party destination around it
    // was hidden, which inverts the opt-in default rather than merely leaking one entry.
    const narrowed: NavGates = { ...ALL_GATES, fullSurface: false }
    expect(toolIds(navSlotFilter(withTools(), { gates: narrowed }))).toEqual(['acme:intake'])
  })

  it('keeps a tool and a nav entry declaring the same axes in lockstep', () => {
    // The structural half, and the one a per-slot case cannot make: both slots run the same
    // predicate today, so assert the PROPERTY that makes that worth keeping. A future axis
    // wired into one slot and not the other fails here, whatever the axis turns out to be.
    const AXES: NavGatedContribution[] = [
      {},
      { advanced: true },
      { intake: true },
      { gate: (g: NavGates) => g.canManageIntegrations },
      { advanced: true, intake: true },
      { advanced: true, gate: (g: NavGates) => g.canManageIntegrations },
      { intake: true, gate: (g: NavGates) => g.canManageIntegrations },
      { advanced: true, intake: true, gate: (g: NavGates) => g.canManageIntegrations },
    ]

    for (const [index, axes] of AXES.entries()) {
      const id = `twin-${index}`
      const paired = (gates: NavGates) => {
        const filtered = navSlotFilter(
          {
            ...slots(),
            nav: [
              {
                id,
                labelKey: 'nav.kaizen',
                icon: 'i-lucide-link',
                surfaces: ['command'] as const,
                ...axes,
              },
            ],
            externalTools: [tool(id, axes)],
          },
          { gates },
        ) as AppSlots
        return {
          nav: filtered.nav.some((i) => i.id === id),
          tool: filtered.externalTools.some((t) => t.id === id),
        }
      }

      // Every setting of the three gate fields these axes read; the rest of `NavGates` is
      // invariant here, so varying it would only restate the same eight verdicts.
      for (const advancedMode of [true, false]) {
        for (const fullSurface of [true, false]) {
          for (const canManageIntegrations of [true, false]) {
            const gates: NavGates = {
              ...ALL_GATES,
              advancedMode,
              fullSurface,
              canManageIntegrations,
            }
            const verdict = paired(gates)
            expect(
              verdict.tool,
              `${JSON.stringify(axes)} under ${JSON.stringify({ advancedMode, fullSurface, canManageIntegrations })}`,
            ).toBe(verdict.nav)
          }
        }
      }
    }
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
    // Derived from the canonical orders rather than re-listed, so a NEW section (the
    // deployment-contributed `externalTools` one) can't be added without its header key.
    for (const group of COMMAND_GROUP_ORDER) check(`layout.commandBar.groups.${group}`)
    for (const group of SIDEBAR_GROUP_ORDER) check(`nav.${group}`)
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
      'models',
      'integrations',
      'infrastructure',
      'workspaceContext',
      'configuration',
      'help',
    ])
    // The model layer is its own section, ahead of the optional integrations: the engines,
    // the per-agent model choice (beside the providers it picks from, rather than under
    // `configuration`), and the two surfaces that evaluate a prompt+agent+model. Sandbox and
    // Kaizen used to sit under `integrations`, which read as a claim they connect to an
    // external system; they don't — they exercise and grade what this section configures.
    const models = groups.find((g) => g.group === 'models')
    expect(models?.items.map((i) => i.id)).toEqual([
      'model-providers',
      'model-config',
      'sandbox',
      'kaizen',
    ])
    const integrations = groups.find((g) => g.group === 'integrations')
    expect(integrations?.items.map((i) => i.id)).toEqual(['integrations-hub'])
    const configuration = groups.find((g) => g.group === 'configuration')
    expect(configuration?.items.map((i) => i.id)).toEqual([
      'workspace-settings',
      'account-settings',
      'operator-dashboard',
      'reports',
    ])
    // The tail section: what teaches the product, rather than what configures it. It is on
    // the sidebar at all because the launch prompt is answered once and the palette was then
    // the only route back to the walkthroughs — asking the user least likely to have found
    // the palette to find it.
    const help = groups.find((g) => g.group === 'help')
    expect(help?.items.map((i) => i.id)).toEqual(['tutorial'])
  })

  it('groupCommands preserves the pre-slice-1 workspace-group order', () => {
    const workspace = groupCommands(NAV_CONTRIBUTIONS).find((g) => g.group === 'workspace')
    // Same order the old CommandBar pushed them in (parity, not a reorder), with genuinely
    // new entries appended after it rather than interleaved. `ui-role` is the one deliberate
    // exception, and it changes no existing entry's RELATIVE position: it sits beside `ui-mode`
    // because the two answer one question ("how much of the app do I see"), and a user who finds
    // one has found the other.
    expect(workspace?.items.map((ci) => ci.item.id)).toEqual([
      'fragments',
      'merge-thresholds',
      'workspace-settings',
      'model-config',
      'service-fragment-defaults',
      'local-models',
      'sandbox',
      'keyboard-shortcuts',
      'ui-mode',
      'ui-role',
      'tutorial',
      'foundational-services',
    ])
  })

  it('sortToolbar yields nothing first-party (consumer-only extension point)', () => {
    expect(sortToolbar(NAV_CONTRIBUTIONS)).toEqual([])
  })
})
