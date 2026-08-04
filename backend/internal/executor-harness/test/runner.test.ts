import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobRegistry, loadRunnerLimits, type RunOptions } from '../src/runner.js'
import { HarnessFailure } from '../src/failure.js'
import type { HarnessCallMetric, ToolSpan } from '../src/pi.js'

/** A tool span with the trajectory fields a real harness stamps, so a test states only what it cares about. */
const span = (partial: Partial<ToolSpan> & Pick<ToolSpan, 'tool'>): ToolSpan => ({
  seq: 0,
  startedAt: 0,
  endedAt: 0,
  ok: true,
  bodies: 'stored',
  args: '',
  result: '',
  argsDropped: 0,
  resultDropped: 0,
  ...partial,
})

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
  failureCause?:
    | 'inactivity-timeout'
    | 'max-duration'
    | 'agent'
    | 'git'
    | 'api'
    | 'no-usable-output'
    | 'no-changes'
}

const job = (): TestJob => ({ jobId: 'exec-1' })

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('loadRunnerLimits', () => {
  it('uses defaults when env is unset', () => {
    expect(loadRunnerLimits({})).toEqual({
      maxDurationMs: 60 * 60_000,
      inactivityMs: 10 * 60_000,
      coldStartMs: 2 * 60_000,
    })
  })

  it('reads positive overrides and ignores junk', () => {
    expect(loadRunnerLimits({ JOB_MAX_DURATION_MS: '1000', JOB_INACTIVITY_MS: 'nope' })).toEqual({
      maxDurationMs: 1000,
      inactivityMs: 10 * 60_000,
      coldStartMs: 2 * 60_000,
    })
  })

  it('allows disabling the cold-start window with 0', () => {
    expect(loadRunnerLimits({ JOB_COLD_START_MS: '0' }).coldStartMs).toBe(0)
  })
})

describe('JobRegistry', () => {
  const limits = { maxDurationMs: 60_000, inactivityMs: 60_000, coldStartMs: 0 }

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
    const registry = new JobRegistry<TestJob, TestResult>(
      limits,
      async (_job, opts: RunOptions) => {
        opts.onProgress?.({ completed: 1, inProgress: 1, total: 3 })
        opts.onProgress?.({ completed: 2, inProgress: 0, total: 3 })
        await tick(50)
        return { summary: 's' }
      },
    )
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('running')
    expect(view?.progress).toEqual({ completed: 2, inProgress: 0, total: 3 })
  })

  it('buffers tool spans and drains them on each poll (drain-on-read)', async () => {
    const registry = new JobRegistry<TestJob, TestResult>(
      limits,
      async (_job, opts: RunOptions) => {
        opts.onSpan?.(span({ tool: 'read', startedAt: 1, endedAt: 2, ok: true }))
        opts.onSpan?.(span({ tool: 'edit_file', startedAt: 2, endedAt: 5, ok: true }))
        await tick(50)
        opts.onSpan?.(span({ tool: 'run_command', startedAt: 6, endedAt: 9, ok: false }))
        await tick(50)
        return { summary: 's' }
      },
    )
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

  it('drains call telemetry per poll and stamps a job-wide sequence on each call', async () => {
    // The point of streaming these: a run killed mid-flight never returns a result, so
    // batching its calls to the end reported nothing at all for a run that spent real tokens.
    const mkCall = (responseText: string): HarnessCallMetric => ({
      promptText: '[]',
      messageCount: 1,
      responseText,
      reasoningText: '',
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      finishReason: 'end_turn',
    })
    const emitted: HarnessCallMetric[] = []
    const registry = new JobRegistry<TestJob, TestResult>(
      limits,
      async (_job, opts: RunOptions) => {
        for (const text of ['one', 'two']) {
          const call = mkCall(text)
          emitted.push(call)
          opts.onCallMetric?.(call)
        }
        await tick(50)
        const late = mkCall('three')
        emitted.push(late)
        opts.onCallMetric?.(late)
        await tick(50)
        return { summary: 's' }
      },
    )
    registry.start('exec-1', job())
    await tick()

    // The first poll drains what was captured so far, and clears the buffer.
    expect(registry.get('exec-1')?.callMetrics?.map((c) => c.responseText)).toEqual(['one', 'two'])
    expect(registry.get('exec-1')?.callMetrics).toBeUndefined()

    await tick(60)
    expect(registry.get('exec-1')?.callMetrics?.map((c) => c.responseText)).toEqual(['three'])

    // The sequence is job-wide and survives the drain, so a call keeps ONE identity across both
    // channels — the drain that carried it here, and the terminal result list. That is what lets
    // the backend mint a stable row id and skip the repeat instead of double-writing it.
    expect(emitted.map((c) => c.seq)).toEqual([0, 1, 2])
  })

  it('stamps the phase a call was emitted in, so a repair round is attributable', async () => {
    // The token-burn instrument's phase axis (docs/initiatives/token-burn-instrumentation.md).
    // The handlers mark `validation-repair` around each repair pass, so the registry — which
    // owns the live phase — is where a call learns which slice of the run spent it. Stamped at
    // EMIT time, never at drain time: the poll that carries a call can land long after the
    // phase moved on, and by then every turn would file under whatever came last.
    const mkCall = (responseText: string): HarnessCallMetric => ({
      promptText: '[]',
      messageCount: 1,
      responseText,
      reasoningText: '',
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      finishReason: 'end_turn',
    })
    const emitted: HarnessCallMetric[] = []
    let phaseDuringRepair = ''
    const registry = new JobRegistry<TestJob, TestResult>(
      limits,
      async (_job, opts: RunOptions) => {
        opts.onPhase?.('agent')
        const first = mkCall('first')
        emitted.push(first)
        opts.onCallMetric?.(first)
        opts.onPhase?.('validation-repair')
        // The read side of the same marker: what the Pi path puts on the proxy URL.
        phaseDuringRepair = opts.currentPhase?.() ?? ''
        const repair = mkCall('repair')
        emitted.push(repair)
        opts.onCallMetric?.(repair)
        opts.onPhase?.('agent')
        return { summary: 's' }
      },
    )
    registry.start('exec-1', job())
    await tick()

    expect(emitted.map((c) => c.phase)).toEqual(['agent', 'validation-repair'])
    expect(phaseDuringRepair).toBe('validation-repair')
  })

  it('records a thrown fault as failed with the `agent` cause', async () => {
    const registry = new JobRegistry(limits, async () => {
      throw new Error('boom')
    })
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    expect(view?.error).toBe('boom')
    expect(view?.failureCause).toBe('agent')
  })

  it("preserves a thrown HarnessFailure's structured cause (git/api), not a generic `agent`", async () => {
    const registry = new JobRegistry(limits, async () => {
      throw new HarnessFailure('git', 'fatal: could not read from remote repository')
    })
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    expect(view?.error).toMatch(/could not read from remote/)
    expect(view?.failureCause).toBe('git')
  })

  it('copies a clean-exit result.failureCause onto the failed-but-done view', async () => {
    // A handler can finish cleanly (state 'done') yet report a failure via result.error +
    // result.failureCause (e.g. no-usable-output). The registry surfaces that cause.
    const registry = new JobRegistry(limits, async () => ({
      summary: 's',
      error: 'the agent produced no report',
      failureCause: 'no-usable-output' as const,
    }))
    registry.start('exec-1', job())
    await tick()
    const view = registry.get('exec-1')
    expect(view?.state).toBe('done')
    expect(view?.result?.error).toMatch(/no report/)
    expect(view?.failureCause).toBe('no-usable-output')
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

  it('aborts a hung job via the inactivity watchdog with a phase + last-tool breadcrumb', async () => {
    const tiny = { maxDurationMs: 60_000, inactivityMs: 20, coldStartMs: 0 }
    const registry = new JobRegistry(tiny, (_job, opts: RunOptions) => {
      // Enter the 'agent' phase and run one tool, then go silent — so the kill can report
      // WHERE it hung and which tool last ran, exactly as a wedged Pi process would.
      opts.onPhase?.('agent')
      opts.onSpan?.(span({ tool: 'bash', startedAt: 1, endedAt: 2, ok: true }))
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
      })
    })
    registry.start('exec-1', job())
    await tick(60)
    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    // The regex-stable phrase the backend matches is preserved...
    expect(view?.error).toMatch(/no agent activity/)
    // ...and the breadcrumb names the hung phase + last tool.
    expect(view?.error).toMatch(/hung in agent phase/)
    expect(view?.error).toMatch(/last completed tool bash .*ago/)
    expect(view?.failureCause).toBe('inactivity-timeout')
    // The extended diagnostic is distinct from the one-line error.
    expect(view?.detail).toMatch(/Phase timings/)
    expect(view?.detail).not.toBe(view?.error)
  })

  it('reports "no tool had completed yet" when a hang happens before any tool', async () => {
    const tiny = { maxDurationMs: 60_000, inactivityMs: 20, coldStartMs: 0 }
    const registry = new JobRegistry(tiny, (_job, opts: RunOptions) => {
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
      })
    })
    registry.start('exec-1', job())
    await tick(60)
    expect(registry.get('exec-1')?.error).toMatch(/no tool had completed yet/)
  })

  it('enforces the max-duration cap even when the job keeps producing output', async () => {
    const tiny = { maxDurationMs: 30, inactivityMs: 60_000, coldStartMs: 0 }
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
    expect(view?.failureCause).toBe('max-duration')
  })

  it('flags a cold start (no output within the window) WITHOUT killing the job (D4)', async () => {
    // A short cold-start window, a long inactivity window: the job goes silent from the
    // start, so the cold-start diagnostic fires but the run stays alive.
    const cold = { maxDurationMs: 60_000, inactivityMs: 60_000, coldStartMs: 15 }
    const registry = new JobRegistry(cold, (_job, opts: RunOptions) => {
      opts.onPhase?.('agent')
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
      })
    })
    registry.start('exec-1', job())
    await tick(40)
    const view = registry.get('exec-1')
    expect(view?.state).toBe('running') // NOT killed
    expect(view?.coldStart?.message).toMatch(/no output .*after start/)
    expect(view?.coldStart?.message).toMatch(/phase: agent/)
  })

  it('does not flag a cold start when output arrives promptly (D4)', async () => {
    const cold = { maxDurationMs: 60_000, inactivityMs: 60_000, coldStartMs: 30 }
    const registry = new JobRegistry<TestJob, TestResult>(cold, async (_job, opts: RunOptions) => {
      opts.onActivity?.() // first token arrives immediately
      await tick(60)
      return { summary: 's' }
    })
    registry.start('exec-1', job())
    await tick(80)
    expect(registry.get('exec-1')?.coldStart).toBeUndefined()
  })
})

// An agent CLI that gives up on a failing upstream request exits NON-ZERO with an empty stderr,
// which is indistinguishable from a crash by exit status alone. What separates them is how long
// the run had been quiet — evidence the registry holds and used to drop.
describe('JobRegistry silent-failure evidence', () => {
  // Only `Date` is faked: the watchdogs' real setTimeout still runs (the tests above depend on
  // it), while the clock can jump far enough for the silence window to be crossed.
  afterEach(() => vi.useRealTimers())
  const fakeClockAt = (iso: string): number => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    return Date.now()
  }

  it('names how long a run had been silent when it dies on a bare non-zero exit', async () => {
    const start = fakeClockAt('2026-07-29T00:00:00Z')
    const limits = { maxDurationMs: 3_600_000, inactivityMs: 600_000, coldStartMs: 0 }
    let fail: (err: Error) => void = () => {}
    const registry = new JobRegistry<TestJob, TestResult>(limits, (_job, opts: RunOptions) => {
      opts.onPhase?.('agent')
      opts.onActivity?.() // one byte of output, then nothing
      return new Promise<TestResult>((_resolve, reject) => {
        fail = reject
      })
    })
    registry.start('exec-1', job())
    await tick()

    // Nine minutes of silence, then the CLI exits 1 having said nothing on stderr.
    vi.setSystemTime(new Date(start + 564_000))
    fail(new Error('claude exited with code 1: (no stderr output)'))
    await tick()

    const view = registry.get('exec-1')
    expect(view?.state).toBe('failed')
    // The one-line error stays the CLI's own message...
    expect(view?.error).toBe('claude exited with code 1: (no stderr output)')
    // ...and the detail carries what the exit code cannot say.
    expect(view?.detail).toMatch(/silent for 564s/)
    expect(view?.detail).toMatch(/no tool had completed yet/)
  })

  it('distinguishes a run that never produced any output, and folds in the cold-start diagnostic', async () => {
    const start = fakeClockAt('2026-07-29T00:00:00Z')
    // A cold-start window short enough for its real timer to fire during the test.
    const limits = { maxDurationMs: 3_600_000, inactivityMs: 600_000, coldStartMs: 15 }
    let fail: (err: Error) => void = () => {}
    const registry = new JobRegistry<TestJob, TestResult>(limits, (_job, opts: RunOptions) => {
      opts.onPhase?.('agent')
      return new Promise<TestResult>((_resolve, reject) => {
        fail = reject
      })
    })
    registry.start('exec-1', job())
    await tick(40) // let the cold-start watchdog fire
    expect(registry.get('exec-1')?.coldStart?.message).toMatch(/no output/)

    vi.setSystemTime(new Date(start + 564_000))
    fail(new Error('claude exited with code 1: (no stderr output)'))
    await tick()

    const detail = registry.get('exec-1')?.detail
    expect(detail).toMatch(/no activity at all in 564s/)
    // ADR 0026 D4's diagnostic reaches the run here — `detail` is the only one of the three
    // failure fields the backend carries onto the step.
    expect(detail).toMatch(/Cold start: agent produced no output/)
  })

  it('stays quiet about silence on a fast failure that was never going to have spoken', async () => {
    fakeClockAt('2026-07-29T00:00:00Z')
    const limits = { maxDurationMs: 3_600_000, inactivityMs: 600_000, coldStartMs: 0 }
    const registry = new JobRegistry<TestJob, TestResult>(limits, async () => {
      throw new HarnessFailure('git', 'fatal: could not read from remote repository')
    })
    registry.start('exec-1', job())
    await tick()

    const view = registry.get('exec-1')
    expect(view?.failureCause).toBe('git')
    expect(view?.detail).not.toMatch(/silent|no agent output/)
  })

  it('leaves the silence clause off an inactivity kill, whose message already states the window', async () => {
    const tiny = { maxDurationMs: 60_000, inactivityMs: 20, coldStartMs: 0 }
    const registry = new JobRegistry<TestJob, TestResult>(tiny, (_job, opts: RunOptions) => {
      opts.onPhase?.('agent')
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
      })
    })
    registry.start('exec-1', job())
    await tick(60)

    const view = registry.get('exec-1')
    expect(view?.failureCause).toBe('inactivity-timeout')
    expect(view?.error).toMatch(/no agent activity for 0s/)
    expect(view?.detail).not.toMatch(/silent for|no activity at all/)
  })
})

describe('JobRegistry.abortAll', () => {
  const limits = { maxDurationMs: 60_000, inactivityMs: 60_000, coldStartMs: 0 }

  it('aborts every running job (graceful shutdown) and skips settled ones', async () => {
    const registry = new JobRegistry<TestJob, TestResult>(limits, (j, opts: RunOptions) => {
      if (j.jobId === 'quick') return Promise.resolve({ summary: 'ok' })
      return new Promise<TestResult>((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(opts.signal?.reason ?? new Error('aborted')),
          { once: true },
        )
      })
    })
    registry.start('quick', { jobId: 'quick' })
    registry.start('hung-1', { jobId: 'hung-1' })
    registry.start('hung-2', { jobId: 'hung-2' })
    await tick()
    expect(registry.get('quick')?.state).toBe('done')
    // The graceful-shutdown poll sees the two hung jobs still running (the settled one drops out).
    expect(registry.runningCount()).toBe(2)

    // Only the two still-running jobs are aborted; their views carry the shutdown reason.
    expect(registry.abortAll('harness shutting down (SIGTERM)')).toBe(2)
    await tick()
    expect(registry.get('hung-1')?.state).toBe('failed')
    expect(registry.get('hung-1')?.error).toMatch(/shutting down/)
    expect(registry.get('hung-2')?.state).toBe('failed')

    // Nothing left running: the shutdown poll can exit, and a second sweep is a no-op.
    expect(registry.runningCount()).toBe(0)
    expect(registry.abortAll('again')).toBe(0)
  })
})
