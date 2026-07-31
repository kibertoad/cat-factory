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
  boardHasTask: true,
  boardHasRun: true,
  boardHasOpenDecision: true,
  boardHasPendingApproval: true,
  boardHasFinishedRun: true,
}

/**
 * A workspace on its very first launch: fully permitted, source control wired, and nothing
 * on the board yet. This is the state the launch prompt auto-opens in, so it is the gate set
 * most of the availability cases below vary from.
 */
const FRESH_BOARD: NavGates = {
  ...ALL_GATES,
  boardHasService: false,
  boardHasTask: false,
  boardHasRun: false,
  boardHasOpenDecision: false,
  boardHasPendingApproval: false,
  boardHasFinishedRun: false,
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

  it('supplies a param for every placeholder its copy names, and no unused ones', () => {
    // A body naming `{repo}` with no `bodyParams` renders the literal braces to the user,
    // and a param with no placeholder is dead weight the next copy edit trips over. Both
    // are invisible until someone runs that exact step, so they are pinned here.
    for (const tour of TUTORIAL_TOURS) {
      for (const s of tour.steps) {
        const body = lookupKey(s.bodyKey)
        const named = new Set([...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
        expect(new Set(Object.keys(s.bodyParams ?? {})), `${tour.id}/${s.id}`).toEqual(named)
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
    expect(filtered.tutorialTours.map((t) => t.id)).not.toContain('first-task')
  })

  it('offers a brand-new board the orientation tour AND the way out of being empty', () => {
    // The state the launch prompt actually auto-opens in. Orientation alone would leave a
    // new workspace with a tour of an empty canvas and no route to a first service, which
    // is what `add-service` exists to fix — so it must survive exactly this gate set.
    const filtered = navSlotFilter(slots(), { gates: FRESH_BOARD })
    expect(filtered.tutorialTours.map((t) => t.id)).toEqual(['board-basics', 'add-service'])
  })

  it('drops the repo tour when no source-control connection can list repositories', () => {
    const noSource: NavGates = { ...FRESH_BOARD, githubAvailable: false }
    expect(navSlotFilter(slots(), { gates: noSource }).tutorialTours.map((t) => t.id)).toEqual([
      'board-basics',
    ])
  })

  it('offers the run tour once a task exists, and the review tour once a run finished', () => {
    const withTask: NavGates = { ...FRESH_BOARD, boardHasService: true, boardHasTask: true }
    expect(navSlotFilter(slots(), { gates: withTask }).tutorialTours.map((t) => t.id)).toContain(
      'run-task',
    )
    expect(
      navSlotFilter(slots(), { gates: withTask }).tutorialTours.map((t) => t.id),
    ).not.toContain('review-merge')

    const finished: NavGates = { ...withTask, boardHasRun: true, boardHasFinishedRun: true }
    expect(navSlotFilter(slots(), { gates: finished }).tutorialTours.map((t) => t.id)).toContain(
      'review-merge',
    )
  })

  it('passes tours through untouched when no gates service is wired', () => {
    const filtered = navSlotFilter(slots(), {})
    expect(filtered.tutorialTours.map((t) => t.id)).toEqual(TUTORIAL_TOURS.map((t) => t.id))
  })
})

describe('the parked-run tour branches', () => {
  const stepIds = (gates: NavGates, tourId: string) =>
    navSlotFilter(slots(), { gates })
      .tutorialTours.find((t) => t.id === tourId)
      ?.steps.map((s) => s.id)

  it('is not offered while nothing is waiting for a human', () => {
    const ids = navSlotFilter(slots(), { gates: FRESH_BOARD }).tutorialTours.map((t) => t.id)
    expect(ids).not.toContain('answer-park')
  })

  it('shows the decision branch only, for a run parked on a decision', () => {
    const decision: NavGates = { ...FRESH_BOARD, boardHasOpenDecision: true }
    expect(stepIds(decision, 'answer-park')).toEqual(['intro', 'resolve', 'decide', 'finish'])
  })

  it('shows the approval branch only, for a run parked on an approval', () => {
    const approval: NavGates = { ...FRESH_BOARD, boardHasPendingApproval: true }
    expect(stepIds(approval, 'answer-park')).toEqual(['intro', 'resolve', 'approve', 'finish'])
  })

  it('follows the card`s own precedence when a board has both', () => {
    // `TaskCard.attention` prefers a decision, so the Resolve click lands on the decision
    // modal: an approval step here would point at a control this click never opens, and
    // the tour would report itself abridged on a board that showed exactly the right thing.
    const both: NavGates = {
      ...FRESH_BOARD,
      boardHasOpenDecision: true,
      boardHasPendingApproval: true,
    }
    expect(stepIds(both, 'answer-park')).toEqual(['intro', 'resolve', 'decide', 'finish'])
  })

  it('drops the run-anatomy step until a run exists to point at', () => {
    const noRun: NavGates = { ...FRESH_BOARD, boardHasService: true, boardHasTask: true }
    expect(stepIds(noRun, 'run-task')).not.toContain('steps')
    expect(stepIds({ ...noRun, boardHasRun: true }, 'run-task')).toContain('steps')
  })

  it('keeps every branch when no gates service is wired', () => {
    // Same dev-open parity as `nav`: with nothing to gate against, nothing is withheld —
    // including the per-step branches, which a bare install must not silently thin out.
    const answerPark = navSlotFilter(slots(), {}).tutorialTours.find((t) => t.id === 'answer-park')
    expect(answerPark?.steps.map((s) => s.id)).toEqual([
      'intro',
      'resolve',
      'decide',
      'approve',
      'finish',
    ])
  })
})
