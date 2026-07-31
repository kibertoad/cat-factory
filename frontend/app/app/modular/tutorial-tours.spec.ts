import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import { TUTORIAL_TOURS, tutorialToursModule } from '~/modular/tutorial-tours'
import { NAV_CONTRIBUTIONS, navSlotFilter } from '~/modular/nav-contributions'
import { isSafeTargetId } from '~/components/tutorial/TutorialOverlay.logic'
import type { AppSlots, NavGates } from '~/modular/nav-contributions'

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
  boardHasService: true,
}

const slots = (): AppSlots =>
  ({
    nav: [...NAV_CONTRIBUTIONS],
    tutorialTours: [...TUTORIAL_TOURS],
  }) as unknown as AppSlots

/** Resolve a dot-path against the en catalog; undefined when any hop is missing. */
function lookupKey(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
}

describe('the built-in tutorial tour catalog', () => {
  it('has unique tour ids and unique step ids within each tour', () => {
    const tourIds = TUTORIAL_TOURS.map((t) => t.id)
    expect(new Set(tourIds).size).toBe(tourIds.length)
    for (const tour of TUTORIAL_TOURS) {
      const stepIds = tour.steps.map((s) => s.id)
      expect(new Set(stepIds).size).toBe(stepIds.length)
      expect(tour.steps.length).toBeGreaterThan(0)
    }
  })

  it('resolves every i18n key it names against the en catalog', () => {
    // Tour copy is looked up with runtime-assembled keys, which the typed-key check
    // cannot cover (i18n drift-guard tier 2): pin the catalog here instead, so a renamed
    // key or a new step without copy fails a test rather than rendering a raw key path.
    for (const tour of TUTORIAL_TOURS) {
      for (const key of [tour.titleKey, tour.descriptionKey]) {
        expect(typeof lookupKey(key), key).toBe('string')
      }
      for (const s of tour.steps) {
        for (const key of [s.titleKey, s.bodyKey]) {
          expect(typeof lookupKey(key), key).toBe('string')
        }
      }
    }
  })

  it('names plain data-testid values as targets, never selectors', () => {
    for (const tour of TUTORIAL_TOURS) {
      for (const s of tour.steps) {
        for (const target of [s.target, ...(s.altTargets ?? [])]) {
          if (target === undefined) continue
          // Asserted through the runtime's OWN guard, not a copy of its regex: the overlay
          // drops an id this rejects, so a built-in tour that tripped it would silently
          // lose the step rather than fail here.
          expect(isSafeTargetId(target), `${tour.id}/${s.id}: ${target}`).toBe(true)
        }
      }
    }
  })

  it('is contributed to the tutorialTours slot by the module', () => {
    expect(tutorialToursModule.slots?.tutorialTours).toEqual([...TUTORIAL_TOURS])
  })
})

describe('navSlotFilter over tutorialTours', () => {
  it('keeps every tour for a fully-gated user', () => {
    const filtered = navSlotFilter(slots(), { gates: ALL_GATES })
    expect(filtered.tutorialTours.map((t) => t.id)).toEqual(TUTORIAL_TOURS.map((t) => t.id))
  })

  it('drops the task-creating tour for a read-only viewer', () => {
    const viewer: NavGates = { ...ALL_GATES, canWriteBoard: false }
    const filtered = navSlotFilter(slots(), { gates: viewer })
    const ids = filtered.tutorialTours.map((t) => t.id)
    expect(ids).toContain('board-basics')
    expect(ids).not.toContain('first-task')
  })

  it('drops the task-creating tour on a board with no service to add a task to', () => {
    // Every targeted step of that tour would time out in turn and it would then claim to
    // have taught the core loop; `board-basics` is what an empty board can deliver.
    const emptyBoard: NavGates = { ...ALL_GATES, boardHasService: false }
    const filtered = navSlotFilter(slots(), { gates: emptyBoard })
    const ids = filtered.tutorialTours.map((t) => t.id)
    expect(ids).toEqual(['board-basics'])
  })

  it('passes tours through untouched when no gates service is wired', () => {
    const filtered = navSlotFilter(slots(), {})
    expect(filtered.tutorialTours.map((t) => t.id)).toEqual(TUTORIAL_TOURS.map((t) => t.id))
  })
})
