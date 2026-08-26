import type { PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import {
  type AdvanceQueueOptions,
  driveJobOptions,
  PgBossWorkRunner,
} from '../src/execution/pgBossRunner.js'
import { PgBossBootstrapRunner } from '../src/execution/bootstrapRunner.js'
import { PgBossEnvironmentTestRunner } from '../src/execution/envTestRunner.js'
import { PgBossEnvConfigRepairRunner } from '../src/execution/envConfigRepairRunner.js'

// The retry policy every drive queue enqueues with. What is worth pinning is not the literal but
// the RELATION: all four queues carry one policy, because it used to be four identical literals and
// a fifth queue is one copy-paste away. The value that matters is `retryBackoff: false`; see
// `driveJobOptions` for why a drive job must not back off exponentially from a worker restart.

const QUEUE_OPTIONS: AdvanceQueueOptions = {
  expireInSeconds: 3600,
  heartbeatSeconds: 60,
  retryLimit: 5,
  retryDelaySeconds: 30,
}

function spyBoss(): { boss: PgBoss; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => 'job-1')
  return { boss: { send } as unknown as PgBoss, send }
}

/** Every drive queue's enqueue, as `(name, run it)`, so the assertion below covers all of them. */
const DRIVE_QUEUES: [string, (boss: PgBoss) => Promise<void>][] = [
  [
    'execution.advance',
    (boss) => new PgBossWorkRunner(boss, QUEUE_OPTIONS).startRun('ws1', 'exec1'),
  ],
  [
    'bootstrap.advance',
    (boss) => new PgBossBootstrapRunner(boss, QUEUE_OPTIONS).startRun('ws1', 'bj1'),
  ],
  [
    'envtest.advance',
    (boss) => new PgBossEnvironmentTestRunner(boss, QUEUE_OPTIONS).startRun('ws1', 'et1'),
  ],
  [
    'envconfig.advance',
    (boss) => new PgBossEnvConfigRepairRunner(boss, QUEUE_OPTIONS).startRun('ws1', 'ec1'),
  ],
]

describe('drive job retry policy', () => {
  it('never backs off exponentially, on any drive queue', async () => {
    // A drive job's dominant failure is the worker going away, which the NEXT attempt succeeds at.
    // Exponential backoff there compounds a process restart into minutes of a stalled run, and
    // nothing else can shorten it: the sweeper reads a `retry`-state job as live and the exclusive
    // singleton no-ops a fresh send.
    for (const [name, enqueue] of DRIVE_QUEUES) {
      const { boss, send } = spyBoss()
      await enqueue(boss)

      expect(send, name).toHaveBeenCalledTimes(1)
      const options = send.mock.calls[0]![2] as Record<string, unknown>
      expect(options.retryBackoff, name).toBe(false)
      expect(options.retryDelay, name).toBe(QUEUE_OPTIONS.retryDelaySeconds)
      expect(options.retryLimit, name).toBe(QUEUE_OPTIONS.retryLimit)
    }
  })

  it('enqueues every drive queue through the ONE shared builder', async () => {
    // Derived from the builder rather than restated, so a queue that grows its own copy of the
    // options fails here instead of quietly drifting. The singletonKey is per-queue by design and
    // is the only field allowed to differ.
    for (const [name, enqueue] of DRIVE_QUEUES) {
      const { boss, send } = spyBoss()
      await enqueue(boss)
      const options = send.mock.calls[0]![2] as Record<string, unknown>
      const { singletonKey, ...shared } = options
      const { singletonKey: _ignored, ...expected } = driveJobOptions('any', QUEUE_OPTIONS)

      expect(singletonKey, name).toEqual(expect.any(String))
      expect(shared, name).toEqual(expected)
    }
  })
})
