import type { PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { type AdvanceQueueOptions, PgBossWorkRunner } from '../src/execution/pgBossRunner.js'

// Pins the lost-resume-signal fix: a resume (`signalDecision`) can race the very advance job
// that just parked the run — that job is still `active`, so the `exclusive` queue dedupes the
// re-`send` to a `null` no-op. If the resume were dropped there the run would sit parked until
// the 5-minute stale-run sweeper, which is exactly the intermittent approval-gate / fork-decision
// e2e timeout. The runner must RETRY the deduped send until the parking job acks (freeing the
// singletonKey), so the resume is never lost. Advances are idempotent, so a retry is safe.

const QUEUE_OPTIONS: AdvanceQueueOptions = {
  expireInSeconds: 3600,
  heartbeatSeconds: 60,
  retryLimit: 5,
  retryDelaySeconds: 30,
}

/** A fake pg-boss whose `send` returns `null` (deduped) for the first `dedupes` calls, then an id. */
function fakeBoss(dedupes: number): { boss: PgBoss; send: ReturnType<typeof vi.fn> } {
  let calls = 0
  const send = vi.fn(async () => (calls++ < dedupes ? null : 'job-1'))
  return { boss: { send } as unknown as PgBoss, send }
}

const noSleep = () => Promise.resolve()

describe('PgBossWorkRunner.signalDecision (reliable resume enqueue)', () => {
  it('sends exactly once when the queue accepts immediately', async () => {
    const { boss, send } = fakeBoss(0)
    const runner = new PgBossWorkRunner(boss, QUEUE_OPTIONS, { sleep: noSleep })

    await runner.signalDecision('ws1', 'exec1', 'dec1', 'approved')

    expect(send).toHaveBeenCalledTimes(1)
    const [queue, data] = send.mock.calls[0]!
    expect(queue).toBe('execution.advance')
    expect(data).toEqual({ workspaceId: 'ws1', executionId: 'exec1' })
  })

  it('retries a deduped send until the parking job frees the singletonKey', async () => {
    // First 3 sends race the still-active parking job (deduped → null), the 4th is accepted.
    const { boss, send } = fakeBoss(3)
    const sleep = vi.fn(noSleep)
    const runner = new PgBossWorkRunner(boss, QUEUE_OPTIONS, { sleep })

    await runner.signalDecision('ws1', 'exec1', 'dec1', 'approved')

    expect(send).toHaveBeenCalledTimes(4) // 3 no-ops + 1 accepted
    expect(sleep).toHaveBeenCalledTimes(3) // waited between each retry, not after success
  })

  it('gives up after a bounded number of attempts (never loops forever)', async () => {
    // The queue never accepts (a genuinely long active drive) — the sweeper is the backstop, so
    // the call must resolve after a bounded retry budget rather than hang.
    const { boss, send } = fakeBoss(Number.POSITIVE_INFINITY)
    const runner = new PgBossWorkRunner(boss, QUEUE_OPTIONS, { sleep: noSleep })

    await expect(runner.signalDecision('ws1', 'exec1', 'dec1', 'approved')).resolves.toBeUndefined()
    expect(send.mock.calls.length).toBeGreaterThan(1)
    expect(send.mock.calls.length).toBeLessThanOrEqual(25) // RESUME_ENQUEUE_RETRY_ATTEMPTS
  })
})
