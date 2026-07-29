import { describe, expect, it } from 'vitest'
import { executionStatusSchema } from '@cat-factory/contracts'
import { LIVE_EXECUTION_STATUSES } from './repositories.js'

// `LIVE_EXECUTION_STATUSES` is the single predicate behind BOTH `ExecutionRepository.listLive`
// and `countActiveByWorkspace` on both runtimes, so run admission control's capacity count and
// the live set the board renders cannot drift apart (docs/initiatives/run-admission-control.md).
// The `satisfies` clause on the constant pins MEMBERSHIP at compile time; what it cannot pin is
// EXHAUSTIVENESS — a new `ExecutionStatus` would type-check while silently falling outside both
// live and terminal, i.e. a run that occupies no slot and settles nothing. These assertions are
// what force the classification decision when slice 2 introduces `queued`.
describe('LIVE_EXECUTION_STATUSES', () => {
  const TERMINAL: string[] = ['done', 'failed']

  it('partitions ExecutionStatus with the terminal statuses — every status is live or settled', () => {
    const covered = [...LIVE_EXECUTION_STATUSES, ...TERMINAL]
    expect(new Set(covered)).toEqual(new Set(executionStatusSchema.options))
    // No status in two buckets: a status cannot both hold a concurrency slot and be settled.
    expect(covered.length).toBe(executionStatusSchema.options.length)
  })

  it('holds the parked states, which occupy a slot despite running no container', () => {
    // A `blocked` (human decision) or `paused` (spend) run resumes WITHOUT re-passing admission,
    // so excluding it would let a workspace exceed its cap simply by parking.
    expect(LIVE_EXECUTION_STATUSES).toContain('blocked')
    expect(LIVE_EXECUTION_STATUSES).toContain('paused')
  })
})
