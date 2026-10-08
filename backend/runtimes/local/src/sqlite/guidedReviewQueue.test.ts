import { describe, expect, it } from 'vitest'
import { createGuidedReviewQueue } from './guidedReviewQueue.js'

const LEASE = 10_000
const NONE: ReadonlySet<string> = new Set()
const answer = { kind: 'message' as const, messageId: 'grm_1' }

describe('SqliteGuidedReviewQueue', () => {
  it('keeps one row per job and hands it to one claimer', () => {
    const q = createGuidedReviewQueue(':memory:')
    q.enqueue('ws', answer, 1)
    q.enqueue('ws', answer, 2)
    expect(q.size()).toBe(1)

    expect(q.claim(10, LEASE, NONE)).toEqual({
      key: 'grm-grm_1',
      workspaceId: 'ws',
      job: answer,
      attempts: 0,
    })
    expect(q.claim(10, LEASE, NONE)).toBeNull()
    // A re-wake while it is being driven does not queue a second drive.
    q.enqueue('ws', answer, 11)
    expect(q.claim(11, LEASE, NONE)).toBeNull()
  })

  it('skips jobs this process drives and reclaims an expired lease', () => {
    const q = createGuidedReviewQueue(':memory:')
    q.enqueue('ws', answer, 1)
    q.claim(10, LEASE, NONE)
    expect(q.claim(10 + LEASE, LEASE, new Set(['grm-grm_1']))).toBeNull()
    expect(q.claim(10 + LEASE, LEASE, NONE)?.key).toBe('grm-grm_1')
  })

  it('recovers orphans on boot, and evicts a job after repeated failures', () => {
    const q = createGuidedReviewQueue(':memory:')
    q.enqueue('ws', answer, 1)
    q.claim(10, LEASE, NONE)
    expect(q.resetOrphans()).toBe(1)
    expect(q.size('queued')).toBe(1)

    q.claim(20, LEASE, NONE)
    q.deferFailure('grm-grm_1', 100)
    expect(q.claim(50, LEASE, NONE)).toBeNull()
    expect(q.claim(100, LEASE, NONE)?.attempts).toBe(1)
    q.deferFailure('grm-grm_1', 200)
    expect(q.evictExhausted(150, 2)).toEqual([])
    expect(q.evictExhausted(200, 2).map((j) => j.key)).toEqual(['grm-grm_1'])
    expect(q.size()).toBe(0)
  })

  it('completing a drive removes the job', () => {
    const q = createGuidedReviewQueue(':memory:')
    q.enqueue('ws', { kind: 'overview', sessionId: 'grs_1', generation: 2 }, 1)
    const claimed = q.claim(10, LEASE, NONE)
    expect(claimed?.key).toBe('gro-grs_1-2')
    q.complete(claimed!.key)
    expect(q.size()).toBe(0)
  })
})
