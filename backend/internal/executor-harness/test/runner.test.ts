import { describe, expect, it } from 'vitest'
import { JobRegistry, loadRunnerLimits, type RunOptions } from '../src/runner.js'

// The registry is generic over the job/result shape; the lifecycle/watchdog tests only
// need a job carrying its id and a result carrying the optional fields they assert on.
interface TestJob {
  jobId: string
}
interface TestResult {
  prUrl?: string
  branch?: string
  summary?: string
  error?: string
}

const job = (): TestJob => ({ jobId: 'exec-1' })

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('loadRunnerLimits', () => {
  it('uses defaults when env is unset', () => {
    expect(loadRunnerLimits({})).toEqual({ maxDurationMs: 60 * 60_000, inactivityMs: 10 * 60_000 })
  })

  it('reads positive overrides and ignores junk', () => {
    expect(loadRunnerLimits({ JOB_MAX_DURATION_MS: '1000', JOB_INACTIVITY_MS: 'nope' })).toEqual({
      maxDurationMs: 1000,
      inactivityMs: 10 * 60_000,
    })
  })
})

describe('JobRegistry', () => {
  const limits = { maxDurationMs: 60_000, inactivityMs: 60_000 }

  it('runs a job to completion and exposes its result', async () => {
    const result: TestResult = { prUrl: 'http://pr/1', branch: 'b', summary: 'done' }
    const registry = new JobRegistry(limits, async () => result)
    const view = registry.start('exec-1', job())
    expect(view.state).toBe('running')

    await tick()
    expect(registry.get('exec-1')?.state).toBe('done')
    expect(registry.get('exec-1')?.result).toEqual(result)
  })

  it('surfaces the latest subtask progress on the running job view', async () => {
    const registry = new JobRegistry<TestJob, TestResult>(limits, async (_job, opts: RunOptions) => {
      opts.onProgress?.({ completed: 1, inProgress: 1, total: 3 })
      opts.onProgress?.({ completed: 2, inProgress: 0, total: 3 })
      await tick(50)
      return { summary: 's' }
    })
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('running')
    expect(view?.progress).toEqual({ completed: 2, inProgress: 0, total: 3 })
  })

  it('buffers tool spans and drains them on each poll (drain-on-read)', async () => {
    const registry = new JobRegistry<TestJob, TestResult>(limits, async (_job, opts: RunOptions) => {
      opts.onSpan?.({ tool: 'read', startedAt: 1, endedAt: 2, ok: true })
      opts.onSpan?.({ tool: 'edit_file', startedAt: 2, endedAt: 5, ok: true })
      await tick(50)
      opts.onSpan?.({ tool: 'run_command', startedAt: 6, endedAt: 9, ok: false })
      await tick(50)
      return { summary: 's' }
    })
    registry.start('exec-1', job())
    await tick()

    // First poll drains the two spans emitted so far...
    const first = registry.get('exec-1')
    expect(first?.spans).toEqual([
      { tool: 'read', startedAt: 1, endedAt: 2, ok: true },
      { tool: 'edit_file', startedAt: 2, endedAt: 5, ok: true },
    ])
    // ...and clears the buffer, so an immediate re-poll carries none.
    expect(registry.get('exec-1')?.spans).toBeUndefined()

    // A later span shows up on the next poll only.
    await tick(60)
    expect(registry.get('exec-1')?.spans).toEqual([
      { tool: 'run_command', startedAt: 6, endedAt: 9, ok: false },
    ])
  })

  it('records a thrown fault as failed', async () => {
    const registry = new JobRegistry(limits, async () => {
      throw new Error('boom')
    })
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    expect(view?.error).toBe('boom')
  })

  it('re-attaches to a running job instead of starting a duplicate', async () => {
    let starts = 0
    const registry = new JobRegistry<TestJob, TestResult>(limits, async () => {
      starts++
      await tick(50)
      return { summary: 's' }
    })
    const first = registry.start('exec-1', job())
    const second = registry.start('exec-1', job())
    expect(second.startedAt).toBe(first.startedAt)
    await tick(80)
    expect(starts).toBe(1)
  })

  it('aborts a hung job via the inactivity watchdog', async () => {
    const tiny = { maxDurationMs: 60_000, inactivityMs: 20 }
    const registry = new JobRegistry(tiny, (_job, opts: RunOptions) => {
      // Never produces activity and never resolves on its own — only the abort
      // signal ends it, exactly as a wedged Pi/git process would.
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
      })
    })
    registry.start('exec-1', job())
    await tick(60)
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    expect(view?.error).toMatch(/no agent activity/)
  })

  it('enforces the max-duration cap even when the job keeps producing output', async () => {
    const tiny = { maxDurationMs: 30, inactivityMs: 60_000 }
    const registry = new JobRegistry(tiny, (_job, opts: RunOptions) => {
      const beat = setInterval(() => opts.onActivity?.(), 5)
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearInterval(beat)
            reject(new Error('killed'))
          },
          { once: true },
        )
      })
    })
    registry.start('exec-1', job())
    await tick(70)
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    expect(view?.error).toMatch(/max duration/)
  })
})
