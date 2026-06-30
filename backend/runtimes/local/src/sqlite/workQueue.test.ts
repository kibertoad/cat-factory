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

    const job = q.claim(10, LEASE, NONE)
    // A healthy run has no prior failures, and claiming does not bump the failure count.
    expect(job).toEqual({ workspaceId: 'ws', executionId: 'ex', attempts: 0 })
    // Claimed → active with a future lease, so it is not claimable again.
    expect(q.size('active')).toBe(1)
    expect(q.claim(10, LEASE, NONE)).toBeNull()
  })

  it('enqueueIfAbsent inserts only when the run has no row at all', () => {
    const q = fresh()
    expect(q.enqueueIfAbsent('ws', 'ex', 1)).toBe(true) // orphan recovered → inserted
    expect(q.enqueueIfAbsent('ws', 'ex', 2)).toBe(false) // already present → untouched
    // A deferred row (active, future lease) must NOT be yanked back to queued by a reconcile pass.
    q.claim(10, LEASE, NONE)
    q.deferRearm('ex', 5000)
    expect(q.enqueueIfAbsent('ws', 'ex', 3)).toBe(false)
    expect(q.size('active')).toBe(1)
  })

  it('claims oldest-first and skips runs being driven in this process', () => {
    const q = fresh()
    q.enqueue('ws', 'a', 1)
    q.enqueue('ws', 'b', 2)
    // 'a' is already being driven in-process → claim skips it and returns 'b'.
    const job = q.claim(10, LEASE, new Set(['a']))
    expect(job?.executionId).toBe('b')
  })

  it('reclaims an active row only once its lease has expired (crash recovery)', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(100, LEASE, NONE) // active, lease_until = 100 + LEASE
    // Before the lease lapses: not claimable.
    expect(q.claim(100 + LEASE - 1, LEASE, NONE)).toBeNull()
    // After the lease lapses: reclaimable (a drive orphaned by a crash).
    const job = q.claim(100 + LEASE, LEASE, NONE)
    expect(job?.executionId).toBe('ex')
    // Reclaiming is NOT a failure, so the retry budget is untouched.
    expect(job?.attempts).toBe(0)
  })

  it('resetOrphans makes every active row immediately claimable (boot recovery)', () => {
    const q = fresh()
    q.enqueue('ws', 'a', 1)
    q.enqueue('ws', 'b', 2)
    q.claim(10, LEASE, NONE) // 'a' active with a future lease
    expect(q.size('active')).toBe(1)
    expect(q.resetOrphans()).toBe(1)
    expect(q.size('active')).toBe(0)
    // 'a' is now queued again and claimable despite its (former) future lease.
    expect(q.claim(20, LEASE, NONE)?.executionId).toBe('a')
  })

  it('markRerun + settle coalesce a mid-drive signal into one re-queue', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(10, LEASE, NONE) // active (a drive in flight)
    expect(q.markRerun('ex')).toBe(true) // a signal arrived mid-drive
    // The finishing driver settles → re-queues (not deletes) because rerun was set.
    expect(q.settle('ex')).toEqual({ requeued: true })
    expect(q.size('queued')).toBe(1)
    // Next settle (no new signal) deletes the row.
    q.claim(20, LEASE, NONE)
    expect(q.settle('ex')).toEqual({ requeued: false })
    expect(q.size()).toBe(0)
  })

  it('markRerun matches nothing when the run is not active', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1) // queued, not active
    expect(q.markRerun('ex')).toBe(false)
  })

  it('deferRearm holds a re-arming run off the queue until notBefore, then it is reclaimable', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(100, LEASE, NONE)
    expect(q.deferRearm('ex', 500)).toEqual({ requeued: false }) // e.g. re-poll a gate at t=500
    expect(q.claim(499, LEASE, NONE)).toBeNull()
    expect(q.claim(500, LEASE, NONE)?.executionId).toBe('ex')
  })

  it('deferRearm coalesces a signal that arrived mid-drive into an immediate re-queue', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    q.claim(10, LEASE, NONE)
    q.markRerun('ex') // a decision arrived while the gate drive was in flight
    // With a pending rerun the run is re-queued NOW, not held for the gate interval.
    expect(q.deferRearm('ex', 9_999)).toEqual({ requeued: true })
    expect(q.claim(20, LEASE, NONE)?.executionId).toBe('ex')
  })

  it('never evicts a run that only ever re-arms (an unbounded gate keeps its budget)', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    let now = 0
    // Re-arm far more than MAX_ATTEMPTS times — a human-review gate can poll indefinitely.
    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      const job = q.claim(now, LEASE, NONE)
      expect(job).not.toBeNull()
      now += 1
      q.deferRearm('ex', now) // re-armed gate: re-poll, resets the failure budget to 0
      now += 1
      // It is never poison — a re-arm is a healthy drive, so attempts stays 0.
      expect(q.evictExhausted(now, MAX_ATTEMPTS, NONE)).toEqual([])
    }
    expect(q.size()).toBe(1)
  })

  it('evictExhausted reaps a run only after MAX_ATTEMPTS consecutive FAILURES', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    let now = 0
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const job = q.claim(now, LEASE, NONE)
      expect(job?.attempts).toBe(i) // failure count climbs by one per errored drive
      now += 1
      q.deferFailure('ex', now) // an errored drive: backoff + bump the failure count
      now += 1
    }
    // Now at the cap: evictExhausted deletes it and reports it so the runner can fail it loudly.
    const evicted = q.evictExhausted(now, MAX_ATTEMPTS, NONE)
    expect(evicted).toEqual([{ workspaceId: 'ws', executionId: 'ex', attempts: MAX_ATTEMPTS }])
    expect(q.size()).toBe(0)
    expect(q.claim(now, LEASE, NONE)).toBeNull()
  })

  it('evictExhausted never reaps a run being driven in this process', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    let now = 0
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      q.claim(now, LEASE, NONE)
      now += 1
      q.deferFailure('ex', now)
      now += 1
    }
    // The run is at the cap but currently in flight (in `exclude`) → not reaped.
    expect(q.evictExhausted(now, MAX_ATTEMPTS, new Set(['ex']))).toEqual([])
    expect(q.size()).toBe(1)
  })

  it('a successful settle resets the failure budget so transient failures do not accumulate', () => {
    const q = fresh()
    q.enqueue('ws', 'ex', 1)
    let now = 0
    // Fail a few times (but below the cap), then a drive succeeds to a standstill+requeue.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      q.claim(now, LEASE, NONE)
      now += 1
      q.deferFailure('ex', now)
      now += 1
    }
    q.claim(now, LEASE, NONE)
    q.markRerun('ex')
    expect(q.settle('ex')).toEqual({ requeued: true }) // success → budget reset
    // A fresh failure now starts the count from zero, so the run is not on the brink of eviction.
    q.claim(now + 1, LEASE, NONE)
    q.deferFailure('ex', now + 2)
    expect(q.evictExhausted(now + 3, MAX_ATTEMPTS, NONE)).toEqual([])
  })
})
