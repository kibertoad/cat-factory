import { describe, expect, it } from 'vitest'
import { MAX_TUTORIAL_TOUR_IDS } from '@cat-factory/contracts'
import type { TutorialProgress } from '@cat-factory/contracts'
import type { TutorialProgressRepository } from '@cat-factory/kernel'
import { TutorialProgressService } from './TutorialProgressService.js'

/** An in-memory store, so the merge semantics are asserted against real read-back. */
function fakeRepo(seed?: TutorialProgress) {
  const rows = new Map<string, TutorialProgress>()
  if (seed) rows.set('u1', seed)
  const repo: TutorialProgressRepository = {
    get: async (userId) => rows.get(userId) ?? null,
    upsert: async (userId, progress) => {
      rows.set(userId, progress)
    },
    remove: async (userId) => {
      rows.delete(userId)
    },
  }
  return { repo, rows }
}

const service = (seed?: TutorialProgress) => {
  const { repo, rows } = fakeRepo(seed)
  return { svc: new TutorialProgressService({ tutorialProgressRepository: repo }), rows }
}

describe('TutorialProgressService', () => {
  it('reads the defaults for a user who has never saved a row', async () => {
    const { svc } = service()
    await expect(svc.get('u1')).resolves.toEqual({
      decision: null,
      completedTourIds: [],
      nudgedTourIds: [],
    })
  })

  it('MERGES both id sets rather than replacing them', async () => {
    // The concurrency story. Two browsers signed in as one person each hold a full local copy and
    // each write it back; a replace drops whatever the other had learned since they diverged, and
    // the symptom is a finished walkthrough quietly going back to "not started" on one machine.
    const { svc } = service()
    await svc.merge('u1', { completedTourIds: ['board-basics'], nudgedTourIds: ['answer-park'] })
    const merged = await svc.merge('u1', { completedTourIds: ['first-task'] })
    expect(merged.completedTourIds).toEqual(['board-basics', 'first-task'])
    expect(merged.nudgedTourIds).toEqual(['answer-park'])
  })

  it('is idempotent, so a retried mirror write cannot duplicate an id', async () => {
    const { svc } = service()
    await svc.merge('u1', { completedTourIds: ['board-basics'] })
    const again = await svc.merge('u1', { completedTourIds: ['board-basics'] })
    expect(again.completedTourIds).toEqual(['board-basics'])
  })

  it('leaves an omitted field alone, and takes an explicit decision', async () => {
    const { svc } = service()
    await svc.merge('u1', { decision: 'accepted' })
    // A write about tours must not clear the answer to the launch prompt.
    expect((await svc.merge('u1', { completedTourIds: ['x'] })).decision).toBe('accepted')
    // Re-answering replaces: a decision is a preference, not an accumulating fact.
    expect((await svc.merge('u1', { decision: 'declined' })).decision).toBe('declined')
    expect((await svc.merge('u1', { decision: null })).decision).toBeNull()
  })

  it('refuses a merge whose RESULT would exceed the per-list cap', async () => {
    // The wire schema caps each REQUEST, which bounds nothing about the stored row: a union of
    // capped requests is uncapped. The row rides every workspace snapshot for this user, so an
    // unbounded one is paid on every board load. Refused, not truncated, so a client bug reads as
    // a refusal rather than as a tail that was never sent.
    const { svc, rows } = service()
    const ids = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => `tour-${from + i}`)
    await svc.merge('u1', { completedTourIds: ids(0, MAX_TUTORIAL_TOUR_IDS) })
    await expect(
      svc.merge('u1', { completedTourIds: ids(MAX_TUTORIAL_TOUR_IDS, 1) }),
    ).rejects.toMatchObject({ details: { reason: 'tutorial_progress_too_large' } })
    // Refused as a whole: the stored row is exactly what the accepted write left.
    expect(rows.get('u1')?.completedTourIds).toHaveLength(MAX_TUTORIAL_TOUR_IDS)
    // The OTHER list is unaffected by its sibling being full, and re-sending what is already
    // stored still succeeds — the cap is on the union, not on the request.
    await expect(
      svc.merge('u1', { completedTourIds: ids(0, 5), nudgedTourIds: ['answer-park'] }),
    ).resolves.toMatchObject({ nudgedTourIds: ['answer-park'] })
  })

  it('resets by DELETING the row, not by writing defaults', async () => {
    // "Never touched the tutorial" and "reset it" have to be the same state, or a user who reset
    // stays distinguishable from a new one in every read that checks for a row.
    const { svc, rows } = service()
    await svc.merge('u1', { decision: 'accepted', completedTourIds: ['board-basics'] })
    expect(rows.has('u1')).toBe(true)
    await expect(svc.reset('u1')).resolves.toEqual({
      decision: null,
      completedTourIds: [],
      nudgedTourIds: [],
    })
    expect(rows.has('u1')).toBe(false)
  })
})
