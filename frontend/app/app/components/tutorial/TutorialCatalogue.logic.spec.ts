import { describe, expect, it } from 'vitest'
import { buildCatalogueRows, summarizeProgress } from './TutorialCatalogue.logic'
import type { TutorialCatalogueEntry, TutorialTourState } from '~/utils/tutorial'

const entry = (
  id: string,
  availability: TutorialCatalogueEntry['availability'],
  stepCount = 3,
): TutorialCatalogueEntry => ({
  tour: {
    id,
    order: 10,
    titleKey: `tutorial.tours.${id}.title`,
    descriptionKey: `tutorial.tours.${id}.description`,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i}`,
      titleKey: 't',
      bodyKey: 'b',
    })),
  },
  availability,
  unmet:
    availability === 'blocked'
      ? [{ id: 'service', labelKey: 'tutorial.requirements.service', met: () => false }]
      : [],
})

const states = (map: Record<string, TutorialTourState>) => (id: string) => map[id] ?? 'notStarted'

describe('buildCatalogueRows', () => {
  it('carries every tour through, ready or not', () => {
    const rows = buildCatalogueRows(
      [entry('a', 'ready'), entry('b', 'blocked'), entry('c', 'not-applicable')],
      states({}),
    )
    expect(rows.map((r) => r.tour.id)).toEqual(['a', 'b', 'c'])
    expect(rows.map((r) => r.startable)).toEqual([true, false, false])
  })

  it('counts the steps of a runnable tour and withholds a count for the rest', () => {
    // A blocked tour's resolved script is not what the user gets once they unblock it, and a
    // number that quietly changes under them is worse than no number.
    const rows = buildCatalogueRows([entry('a', 'ready', 4), entry('b', 'blocked', 4)], states({}))
    expect(rows[0]?.stepCount).toBe(4)
    expect(rows[1]?.stepCount).toBeNull()
  })

  it('labels each row from the user`s own progress', () => {
    const rows = buildCatalogueRows(
      [entry('a', 'ready'), entry('b', 'ready'), entry('c', 'ready')],
      states({ a: 'completed', b: 'paused', c: 'inProgress' }),
    )
    expect(rows.map((r) => r.action)).toEqual(['restart', 'resume', 'continue'])
  })

  it('keeps a blocked tour`s unmet requirements for the reason list', () => {
    const [row] = buildCatalogueRows([entry('a', 'blocked')], states({}))
    expect(row?.unmet.map((r) => r.id)).toEqual(['service'])
  })
})

describe('summarizeProgress', () => {
  /** The launch offer is still unanswered, so only the rows can make anything resettable. */
  const unanswered = { launchOfferAnswered: false }
  const rows = (map: Record<string, TutorialTourState>, ids: string[]) =>
    buildCatalogueRows(
      ids.map((id) => entry(id, 'ready')),
      states(map),
    )

  it('counts completions against the WHOLE catalog, not the runnable part', () => {
    // Counting only what this board can offer today would move the denominator every time a
    // repo was linked or a run finished — and "2 of 2" on a board with four walkthroughs
    // still waiting reads as a finished tutorial, which is what this surface disproves.
    const all = buildCatalogueRows(
      [entry('a', 'ready'), entry('b', 'blocked'), entry('c', 'not-applicable')],
      states({ a: 'completed' }),
    )
    expect(summarizeProgress(all, unanswered)).toMatchObject({ completed: 1, total: 3 })
  })

  it('offers a reset for a paused tour, not only for completed ones', () => {
    expect(summarizeProgress(rows({}, ['a', 'b']), unanswered).resettable).toBe(false)
    expect(summarizeProgress(rows({ a: 'paused' }, ['a', 'b']), unanswered).resettable).toBe(true)
    expect(summarizeProgress(rows({ a: 'completed' }, ['a', 'b']), unanswered).resettable).toBe(
      true,
    )
  })

  it('offers a reset to a user who only ever answered the launch offer', () => {
    // The case keying Reset off the rows alone got wrong, and the one that matters most: someone
    // who clicked "No thanks" and took no tour has nothing completed and nothing paused, yet the
    // saved answer is exactly what stops the prompt returning. Hiding the control left them no
    // route back to the first-launch experience Reset promises.
    expect(summarizeProgress(rows({}, ['a', 'b']), { launchOfferAnswered: true }).resettable).toBe(
      true,
    )
  })

  it('offers no reset on a genuinely untouched install', () => {
    expect(summarizeProgress([], unanswered).resettable).toBe(false)
  })
})
