import { describe, expect, it } from 'vitest'
import { SqliteWorkQueue, createWorkQueue } from './workQueue.js'

// Unit coverage for the durable execution work queue (the no-pg-boss durability substrate;
// docs/initiatives/mothership-mode.md PR 2). All against an in-memory database — pure persistence,
// no driving, no timers.

const LEASE = 10_000
const MAX_ATTEMPTS = 5
const NONE: ReadonlySet<string> = new Set()

function fresh(): SqliteWorkQueue {
  return createWorkQueue(':memory:')
}

describe('SqliteWorkQueue', () => {
  it('enqueue is deduped per run (one row per execution id) and claim marks it active', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.enqueue('ws', 'ex', 2) // a second trigger for the same run does NOT add a second row
    expect(q.size()).toBe(1)
    expect(q.size('queued')).toBe(1)

    const job = q.claim(10, LEASE, MAX_ATTEMPTS, NONE)
    expect(job).toEqual({ workspaceId: 'ws', executionId: 'ex', attempts: 1 })
    // Claimed → active with a future lease, so it is not claimable again.
    expect(q.size('active')).toBe(1)
    expect(q.claim(10, LEASE, MAX_ATTEMPTS, NONE)).toBeNull()
  })

  it('claims oldest-first and skips runs being driven in this process', () => {
    const q = fresh()
    q.enqueue('ws', 'a', 1)
    q.enqueue('ws', 'b', 2)
    // 'a' is already being driven in-process → claim skips it and returns 'b'.
    const job = q.claim(10, LEASE, MAX_ATTEMPTS, new Set(['a']))
    expect(job?.executionId).toBe('b')
  })

  it('reclaims an active row only once its lease has expired (crash recovery)', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(100, LEASE, MAX_ATTEMPTS, NONE) // active, lease_until = 100 + LEASE
    // Before the lease lapses: not claimable.
    expect(q.claim(100 + LEASE - 1, LEASE, MAX_ATTEMPTS, NONE)).toBeNull()
    // After the lease lapses: reclaimable (a drive orphaned by a crash).
    const job = q.claim(100 + LEASE, LEASE, MAX_ATTEMPTS, NONE)
    expect(job?.executionId).toBe('ex')
    expect(job?.attempts).toBe(2) // attempts accumulates across reclaims
  })

  it('resetOrphans makes every active row immediately claimable (boot recovery)', () => {
    const q = fresh()
    q.enqueue('ws', 'a', 1)
    q.enqueue('ws', 'b', 2)
    q.claim(10, LEASE, MAX_ATTEMPTS, NONE) // 'a' active with a future lease
    expect(q.size('active')).toBe(1)
    expect(q.resetOrphans()).toBe(1)
    expect(q.size('active')).toBe(0)
    // 'a' is now queued again and claimable despite its (former) future lease.
    expect(q.claim(20, LEASE, MAX_ATTEMPTS, NONE)?.executionId).toBe('a')
  })

  it('markRerun + settle coalesce a mid-drive signal into one re-queue', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(10, LEASE, MAX_ATTEMPTS, NONE) // active (a drive in flight)
    expect(q.markRerun('ex')).toBe(true) // a signal arrived mid-drive
    // The finishing driver settles → re-queues (not deletes) because rerun was set.
    expect(q.settle('ex')).toEqual({ requeued: true })
    expect(q.size('queued')).toBe(1)
    // Next settle (no new signal) deletes the row.
    q.claim(20, LEASE, MAX_ATTEMPTS, NONE)
    expect(q.settle('ex')).toEqual({ requeued: false })
    expect(q.size()).toBe(0)
  })

  it('markRerun matches nothing when the run is not active', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1) // queued, not active
    expect(q.markRerun('ex')).toBe(false)
  })

  it('defer holds a run off the queue until notBefore, then it is reclaimable', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(100, LEASE, MAX_ATTEMPTS, NONE)
    q.defer('ex', 500) // e.g. a re-armed gate: re-poll at t=500
    expect(q.claim(499, LEASE, MAX_ATTEMPTS, NONE)).toBeNull()
    expect(q.claim(500, LEASE, MAX_ATTEMPTS, NONE)?.executionId).toBe('ex')
  })

  it('evicts a poison run once it exceeds the attempts cap', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    let now = 0
    // Drive it `maxAttempts` times (each claim bumps attempts then we re-queue it).
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const job = q.claim(now++, LEASE, MAX_ATTEMPTS, NONE)
      expect(job).not.toBeNull()
      q.enqueue('ws', 'ex', now) // re-queue (clears lease) so it is claimable again
    }
    // The next claim sees attempts >= cap → evicts the row instead of re-driving it.
    expect(q.claim(now, LEASE, MAX_ATTEMPTS, NONE)).toBeNull()
    expect(q.size()).toBe(0)
  })
})
