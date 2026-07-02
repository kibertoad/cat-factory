import { describe, expect, it } from 'vitest'
import { JobRegistry, type RunOptions } from '../src/runner.js'

// The deploy harness carries its own copy of the registry; pin the graceful-shutdown
// abort sweep here too so the copies can't drift on it.

interface TestJob {
  jobId: string
}
interface TestResult {
  error?: string
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('JobRegistry.abortAll', () => {
  const limits = { maxDurationMs: 60_000, inactivityMs: 60_000 }

  it('aborts every running job (graceful shutdown) and skips settled ones', async () => {
    const registry = new JobRegistry<TestJob, TestResult>(limits, (j, opts: RunOptions) => {
      if (j.jobId === 'quick') return Promise.resolve({})
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(opts.signal?.reason ?? new Error('aborted')),
          { once: true },
        )
      })
    })
    registry.start('quick', { jobId: 'quick' })
    registry.start('hung', { jobId: 'hung' })
    await tick()
    expect(registry.get('quick')?.state).toBe('done')

    expect(registry.abortAll('harness shutting down (SIGTERM)')).toBe(1)
    await tick()
    expect(registry.get('hung')?.state).toBe('failed')
    expect(registry.get('hung')?.error).toMatch(/shutting down/)
    expect(registry.abortAll('again')).toBe(0)
  })
})
