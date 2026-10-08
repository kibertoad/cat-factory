import { createRecordingLogger, type GuidedReviewJob } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { SqliteGuidedReviewRunner } from './guidedReviewRunner.js'
import { createGuidedReviewQueue } from './sqlite/guidedReviewQueue.js'

const OPTS = {
  leaseMs: 60_000,
  errorBackoffMs: 0,
  sweepIntervalMs: 60_000,
  maxAttempts: 2,
  concurrency: 4,
}
const job: GuidedReviewJob = { kind: 'message', messageId: 'grm_1' }

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SqliteGuidedReviewRunner', () => {
  it('drives a job started twice concurrently exactly once', async () => {
    const queue = createGuidedReviewQueue(':memory:')
    const runner = new SqliteGuidedReviewRunner(queue, OPTS, createRecordingLogger())
    const driven: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    runner.bind({
      runJob: async (_ws, j) => {
        driven.push(j.kind)
        await gate
        return { done: true }
      },
      abandonJob: async () => {},
    })
    await Promise.all([runner.start('ws', job), runner.start('ws', job)])
    release()
    await settle()
    expect(driven).toEqual(['message'])
    expect(queue.size()).toBe(0)
    runner.stop()
  })

  it('re-drives a job left in flight by a previous process', async () => {
    const queue = createGuidedReviewQueue(':memory:')
    queue.enqueue('ws', job, 1)
    queue.claim(2, OPTS.leaseMs, new Set())
    const driven: GuidedReviewJob[] = []
    const runner = new SqliteGuidedReviewRunner(queue, OPTS, createRecordingLogger())
    runner.bind({
      runJob: async (_ws, j) => {
        driven.push(j)
        return { done: true }
      },
      abandonJob: async () => {},
    })
    await settle()
    expect(driven).toEqual([job])
    runner.stop()
  })

  it('re-queues a job that is still working and drives it again until it settles', async () => {
    const queue = createGuidedReviewQueue(':memory:')
    const runner = new SqliteGuidedReviewRunner(queue, OPTS, createRecordingLogger())
    const progress = [
      { done: false as const, pollAfterMs: 1 },
      { done: false as const, pollAfterMs: 1 },
    ]
    let calls = 0
    runner.bind({
      runJob: async () => {
        calls += 1
        return progress.shift() ?? { done: true }
      },
      abandonJob: async () => {},
    })
    await runner.start('ws', job)
    // The re-queue wakes on a real timer, so wait for the queue to drain rather than for a tick count.
    await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 2_000, interval: 5 })
    // Progress is not failure: three passes exceed `maxAttempts` (2) and the job still completes.
    expect(calls).toBe(3)
    expect(queue.size()).toBe(0)
    runner.stop()
  })

  it('retries a failing drive, then drops it and settles its row as abandoned', async () => {
    const queue = createGuidedReviewQueue(':memory:')
    const logger = createRecordingLogger()
    const runner = new SqliteGuidedReviewRunner(queue, OPTS, logger)
    let calls = 0
    const abandoned: GuidedReviewJob[] = []
    runner.bind({
      runJob: async () => {
        calls += 1
        throw new Error('mothership unreachable')
      },
      abandonJob: async (_ws, j) => void abandoned.push(j),
    })
    await runner.start('ws', job)
    for (let i = 0; i < 5; i++) await settle()
    expect(calls).toBe(OPTS.maxAttempts)
    expect(queue.size()).toBe(0)
    expect(logger.lines.some((e) => e.level === 'error')).toBe(true)
    // Without this the mothership row stays live and its thread reads as busy forever.
    expect(abandoned).toEqual([job])
    runner.stop()
  })

  it('keeps a given-up job queued while settling it as abandoned fails', async () => {
    const queue = createGuidedReviewQueue(':memory:')
    const runner = new SqliteGuidedReviewRunner(queue, OPTS, createRecordingLogger())
    runner.bind({
      runJob: async () => {
        throw new Error('mothership unreachable')
      },
      abandonJob: async () => {
        throw new Error('mothership unreachable')
      },
    })
    await runner.start('ws', job)
    for (let i = 0; i < 5; i++) await settle()
    // Dropping it here would leave the mothership row live with nothing left to settle it.
    expect(queue.size()).toBe(1)
    runner.stop()
  })
})
