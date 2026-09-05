import type { PgBoss, Queue } from 'pg-boss'

// Dead-letter policy for the Node facade's pg-boss queues
// (docs/initiatives/observability-logging-gaps.md, B5 / slice 4.5).
//
// Without a dead-letter queue, a job that exhausts `retryLimit` lands in pg-boss's `failed`
// state and NOTHING ever reads it — a webhook delivery that can never be projected, a run that
// can never start, gone with its last failure buried in whichever log line happened to catch
// it. The Worker's queue config has always documented a `dead_letter_queue` per consumer; the
// Node side had `deadLetter` on zero `createQueue` calls, which is the facade-parity half of
// the same gap.
//
// The policy is deliberately small: EVERY queue gets a DLQ, named by convention, created
// alongside it. A DLQ is itself a queue with no worker — pg-boss requires it to exist before a
// job can be copied into it — and it is swept for REPORTING only (`sweepDeadLetterQueues`),
// never replayed automatically: a job that failed every retry will fail again, and an
// automatic replay turns a bounded loss into an unbounded loop.

/** Appended to a queue's name to name its dead-letter sibling. */
export const DEAD_LETTER_SUFFIX = '.dlq'

/** The dead-letter queue name for `queue`. */
function deadLetterQueueName(queue: string): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`
}

/** Whether a queue name is a dead-letter queue (so a depth probe can classify it). */
export function isDeadLetterQueue(name: string): boolean {
  return name.endsWith(DEAD_LETTER_SUFFIX)
}

/**
 * Create `queue` with its dead-letter sibling, and the sibling itself. Use in place of a bare
 * `boss.createQueue(name, options)` so a new queue cannot be added without one — the DLQ has to
 * exist first, or pg-boss rejects the parent's `deadLetter` reference.
 *
 * Idempotent, like `createQueue` itself: both calls are safe on every boot.
 */
export async function createQueueWithDeadLetter(
  boss: PgBoss,
  queue: string,
  options: Omit<Queue, 'name'> = {},
): Promise<void> {
  const dlq = deadLetterQueueName(queue)
  // The DLQ takes no policy of its own: it is a holding table nothing works, so the
  // parent's `exclusive`/singleton semantics would only constrain what can be COPIED in.
  await boss.createQueue(dlq)
  await boss.createQueue(queue, { ...options, deadLetter: dlq })
}
