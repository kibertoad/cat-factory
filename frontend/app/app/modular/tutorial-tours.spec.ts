import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import {
  TUTORIAL_REQUIREMENTS,
  TUTORIAL_TOURS,
  tutorialToursModule,
} from '~/modular/tutorial-tours'
import { resolveTourCatalogue, resolveTours } from '~/utils/tutorial'
import { isSafeTargetId } from '~/components/tutorial/TutorialOverlay.logic'
import type { NavGates } from '~/modular/nav-contributions'

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

/** Resolve a dot-path against the en catalog; undefined when any hop is missing. */
function lookupKey(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
}

/**
 * The layer's srcDir. Anchored on the package directory rather than on `import.meta.url`,
 * which under the happy-dom test environment is not a `file:` URL at all.
 */
const SRC_DIR = join(process.cwd(), 'app')

/**
 * The two ways this layer names a test id, both of which a tour may legitimately anchor on.
 *
 *  - written straight onto an element, in either quoting style, including the bound form
 *    (`:data-testid="'foo'"`);
 *  - declared as a `testId` field on a DATA contribution — the nav catalog's items carry one
 *    and `SideBar.vue` renders it as `:data-testid="item.testId"`, which is how the whole
 *    `nav-*` family (`nav-add-from-repo` among them) reaches the DOM.
 *
 * A template literal (`` `tutorial-start-${id}` ``) matches neither, which is correct: that is
 * not an id, it is a family of them, and no built-in step anchors on one.
 */
const ID_PATTERNS = [
  /data-testid\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  /\btestId\s*:\s*(?:'([^']*)'|"([^"]*)")/g,
]

/**
 * Every `.vue`/`.ts` file the layer SHIPS. Test sources are excluded in both spellings: an id
 * that exists only in a spec or a fixture is not rendered by anything, so counting one would
 * let the guard pass on a tour anchored to a control that no longer exists.
 */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return /\.(vue|ts)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name) ? [path] : []
  })
}

/** Every anchor the built-in catalog declares, labelled with the step that declares it. */
function declaredAnchors(): { label: string; id: string }[] {
  const out: { label: string; id: string }[] = []
  for (const tour of TUTORIAL_TOURS) {
    for (const s of tour.steps) {
      for (const id of [s.target, ...(s.altTargets ?? [])]) {
        if (id !== undefined) out.push({ label: `${tour.id}/${s.id}: ${id}`, id })
      }
    }
  }
  return out
}

/** Every static test id this layer actually renders. */
function renderedTestIds(): Set<string> {
  const ids = new Set<string>()
  for (const file of walk(SRC_DIR)) {
    // The catalog itself declares the ids under test; counting it would make this vacuous.
    if (file.endsWith(join('modular', 'tutorial-tours.ts'))) continue
    const source = readFileSync(file, 'utf8')
    for (const pattern of ID_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const raw = (match[1] ?? match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
        if (isSafeTargetId(raw)) ids.add(raw)
      }
    }
  }
  return ids
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
    for (const anchor of declaredAnchors()) {
      // Asserted through the runtime's OWN guard, not a copy of its regex: the overlay
      // drops an id this rejects, so a built-in tour that tripped it would silently
      // lose the step rather than fail here.
      expect(isSafeTargetId(anchor.id), anchor.label).toBe(true)
    }
  })

  it('anchors every step on a data-testid this layer actually renders', () => {
    // The drift guard. A tour's anchors are the ONE thing about it that nothing else in the
    // build checks: a renamed `data-testid` passes typecheck, lint and the whole e2e suite,
    // and five of the ids below (`nav-add-from-repo`, `add-service-repo-search`,
    // `add-service-submit`, `pipeline-picker-trigger`, `inspector-merge-pr`) have no other
    // consumer at all — the tour is the only thing that names them.
    //
    // The failure it prevents is worse than a dead step. None of those steps carries a `when`,
    // so `unexpectedlySkippedSteps` counts the miss and EVERY user who takes that tour lands on
    // a permanent "you missed N steps" notice: the tour would go on making a false claim about
    // itself, in production, with nothing red anywhere.
    //
    // Scoped to the built-in catalog on purpose — a consumer deployment's tours anchor on
    // controls that live in ITS layer, which this repo cannot see and must not fail over.
    const rendered = renderedTestIds()
    // Guard the guard: a scan that silently matched nothing would pass every assertion below.
    expect(rendered.size).toBeGreaterThan(100)

    const missing = declaredAnchors()
      .filter((anchor) => !rendered.has(anchor.id))
      .map((anchor) => anchor.label)
    expect(missing).toEqual([])
  })

  it('is contributed to the tutorialTours slot by the module', () => {
    expect(tutorialToursModule.slots?.tutorialTours).toEqual([...TUTORIAL_TOURS])
  })
})

describe('tour availability across the catalog', () => {
  /** The ids a board can START right now — what the launch prompt offers. */
  const ready = (gates: NavGates) => resolveTours(TUTORIAL_TOURS, gates).map((t) => t.id)
  /** The catalogue's own view: every tour, with what is holding each one back. */
  const entry = (gates: NavGates, tourId: string) =>
    resolveTourCatalogue(TUTORIAL_TOURS, gates).find((e) => e.tour.id === tourId)

  it('offers every tour to a fully-gated user on a fully-populated board', () => {
    expect(ready(ALL_GATES)).toEqual(TUTORIAL_TOURS.map((t) => t.id))
  })

  it('lists the whole catalog whatever the gates say, holding back rather than hiding', () => {
    // The catalogue surface's contract. A fresh board can run two of the six walkthroughs;
    // dropping the other four (all a slot filter could do) would misrepresent the product as
    // shipping two, to exactly the user who came looking for the rest.
    const catalogue = resolveTourCatalogue(TUTORIAL_TOURS, FRESH_BOARD)
    expect(catalogue.map((e) => e.tour.id)).toEqual(TUTORIAL_TOURS.map((t) => t.id))
    expect(catalogue.filter((e) => e.availability === 'ready').map((e) => e.tour.id)).toEqual([
      'board-basics',
      'add-service',
    ])
  })

  it('holds the task-creating tour back from a read-only viewer, and says why', () => {
    const viewer: NavGates = { ...ALL_GATES, canWriteBoard: false }
    expect(ready(viewer)).toContain('board-basics')
    expect(ready(viewer)).not.toContain('first-task')
    expect(entry(viewer, 'first-task')?.unmet.map((r) => r.id)).toEqual(['board-write'])
  })

  it('holds the task-creating tour back on a board with no service to add a task to', () => {
    // Every targeted step of that tour would time out in turn and it would then claim to
    // have taught the core loop; `board-basics` is what an empty board can deliver.
    const emptyBoard: NavGates = { ...ALL_GATES, boardHasService: false }
    expect(ready(emptyBoard)).not.toContain('first-task')
    expect(entry(emptyBoard, 'first-task')?.unmet.map((r) => r.id)).toEqual(['service'])
  })

  it('offers a brand-new board the orientation tour AND the way out of being empty', () => {
    // The state the launch prompt actually auto-opens in. Orientation alone would leave a
    // new workspace with a tour of an empty canvas and no route to a first service, which
    // is what `add-service` exists to fix — so it must survive exactly this gate set.
    expect(ready(FRESH_BOARD)).toEqual(['board-basics', 'add-service'])
  })

  it('names the missing connection when no source control can list repositories', () => {
    const noSource: NavGates = { ...FRESH_BOARD, githubAvailable: false }
    expect(ready(noSource)).toEqual(['board-basics'])
    expect(entry(noSource, 'add-service')?.unmet.map((r) => r.id)).toEqual(['source-control'])
  })

  it('offers the run tour once a task exists, and the review tour once a run finished', () => {
    const withTask: NavGates = { ...FRESH_BOARD, boardHasService: true, boardHasTask: true }
    expect(ready(withTask)).toContain('run-task')
    expect(ready(withTask)).not.toContain('review-merge')
    expect(entry(withTask, 'review-merge')?.unmet.map((r) => r.id)).toEqual(['finished-run'])

    const finished: NavGates = { ...withTask, boardHasRun: true, boardHasFinishedRun: true }
    expect(ready(finished)).toContain('review-merge')
  })

  it('names every unmet requirement, not just the first', () => {
    // The reader has to do all of them; reporting one at a time turns unblocking a tour into
    // a guessing game with a fresh answer after each attempt.
    const bare: NavGates = { ...FRESH_BOARD, canWriteBoard: false, githubAvailable: false }
    expect(entry(bare, 'add-service')?.unmet.map((r) => r.id)).toEqual([
      'board-write',
      'source-control',
    ])
  })

  it('resolves every requirement copy key against the en catalog', () => {
    // Same tier-2 i18n guard as the tour copy above: a requirement's label is looked up from
    // data, so a renamed key would reach the user as a raw path in the "available once" list.
    for (const requirement of Object.values(TUTORIAL_REQUIREMENTS)) {
      expect(typeof lookupKey(requirement.labelKey), requirement.labelKey).toBe('string')
    }
  })

  it('declares its requirements from the shared set', () => {
    // A tour with an inline requirement object is not wrong, but a duplicate of a shared one
    // is: two copies of "a service on the board" drift into two different sentences about the
    // same gate. Pinning the built-ins to the table keeps that a deliberate act.
    const shared = new Set(Object.values(TUTORIAL_REQUIREMENTS).map((r) => r.id))
    for (const tour of TUTORIAL_TOURS) {
      for (const requirement of tour.requires ?? []) {
        expect(shared, `${tour.id}: ${requirement.id}`).toContain(requirement.id)
      }
    }
  })

  it('passes tours through untouched when no gates service is wired', () => {
    expect(resolveTours(TUTORIAL_TOURS, null).map((t) => t.id)).toEqual(
      TUTORIAL_TOURS.map((t) => t.id),
    )
  })
})

describe('the parked-run tour branches', () => {
  const stepIds = (gates: NavGates, tourId: string) =>
    resolveTours(TUTORIAL_TOURS, gates)
      .find((t) => t.id === tourId)
      ?.steps.map((s) => s.id)

  it('is not offered while nothing is waiting for a human', () => {
    expect(resolveTours(TUTORIAL_TOURS, FRESH_BOARD).map((t) => t.id)).not.toContain('answer-park')
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
    const answerPark = resolveTours(TUTORIAL_TOURS, null).find((t) => t.id === 'answer-park')
    expect(answerPark?.steps.map((s) => s.id)).toEqual([
      'intro',
      'resolve',
      'decide',
      'approve',
      'finish',
    ])
  })
})
