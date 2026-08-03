import type { OperationalGaugeSample, OperationalMetrics } from '@cat-factory/kernel'
import type { PgBoss } from 'pg-boss'
import { DEAD_LETTER_SUFFIX, isDeadLetterQueue } from './execution/deadLetter.js'

// Queue-depth + dead-letter observability for the Node facade's durable substrate.
//
// Backlog is the operational signal with no proxy: a wedged consumer looks EXACTLY like an
// idle deployment in every run-level aggregate — no runs failing, no runs slow, because none
// of them started. `platform_health`'s backlog condition reads the run table, which counts
// runs that were admitted; a job that never left the queue is invisible to it.
//
// ONE `getQueues()` call answers every queue (pg-boss aggregates server-side), so this is a
// per-tick aggregate rather than the banned per-queue point-read loop.

/**
 * The depth reading per queue. `ready` is the true backlog — pg-boss's `queuedCount` includes
 * future-dated deferred jobs that are not yet runnable, and counting those as backlog would
 * make a healthy scheduled workload look like a wedged one.
 */
export type QueueDepthState = 'ready' | 'active' | 'failed'

/**
 * Read every pg-boss queue's depth as gauge samples. The QUEUE NAME is a bounded dimension
 * (the facade creates a fixed set at boot), so it is safe on a metric series and is the split
 * that matters — "the backlog is on `execution.advance`" and "the backlog is on `github.sync`"
 * are different incidents.
 *
 * Dead-letter queues are reported under their own `state` rather than being folded into the
 * live counts: a job sitting in a DLQ is not backlog waiting to drain, it is work that was
 * GIVEN UP ON, and averaging the two hides exactly the one an operator must act on.
 */
export async function probePgBossQueueDepth(boss: PgBoss): Promise<OperationalGaugeSample[]> {
  const queues = await boss.getQueues()
  const samples: OperationalGaugeSample[] = []
  for (const queue of queues) {
    if (isDeadLetterQueue(queue.name)) {
      // A DLQ's whole contents are the signal — every job in it exhausted its retries.
      samples.push({
        gauge: 'queue.depth',
        dimensions: { queue: queue.name, state: 'dead_letter' },
        value: queue.totalCount,
      })
      continue
    }
    samples.push(
      {
        gauge: 'queue.depth',
        dimensions: { queue: queue.name, state: 'ready' },
        value: queue.readyCount,
      },
      {
        gauge: 'queue.depth',
        dimensions: { queue: queue.name, state: 'active' },
        value: queue.activeCount,
      },
      {
        gauge: 'queue.depth',
        dimensions: { queue: queue.name, state: 'failed' },
        value: queue.failedCount,
      },
    )
  }
  return samples
}

/** How often the dead-letter sweep looks. Hourly: a dead-lettered job is not time-critical. */
export const DEAD_LETTER_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Report what is sitting in the dead-letter queues. pg-boss moves a job here once it has
 * exhausted `retryLimit`, and NOTHING reads these tables — before this, a webhook delivery or
 * a run start that could never succeed simply stopped existing, with its last failure buried
 * in whichever log line happened to catch it.
 *
 * Deliberately a REPORT, not a re-drive: a job that failed every retry will fail again, and an
 * automatic replay would turn a bounded loss into an unbounded loop. What it produces is a
 * count an operator can alert on and a log line naming the queue, so the decision to replay
 * stays a human one.
 *
 * Returns the total across all DLQs (0 when there are none), so a caller can log only when
 * there is something to say.
 */
export async function sweepDeadLetterQueues(
  boss: PgBoss,
  metrics: OperationalMetrics,
  log: { warn(msg: string, fields?: Record<string, unknown>): void },
): Promise<number> {
  const queues = await boss.getQueues()
  let total = 0
  for (const queue of queues) {
    if (!isDeadLetterQueue(queue.name) || queue.totalCount === 0) continue
    total += queue.totalCount
    metrics.increment('queue.job_dead_lettered', { queue: queue.name }, queue.totalCount)
    log.warn('jobs are sitting in a dead-letter queue', {
      scope: 'dead-letter',
      queue: queue.name,
      // The SOURCE queue is what an operator needs to look at; the DLQ name is derived from it.
      sourceQueue: queue.name.slice(0, -DEAD_LETTER_SUFFIX.length),
      jobs: queue.totalCount,
    })
  }
  return total
}
