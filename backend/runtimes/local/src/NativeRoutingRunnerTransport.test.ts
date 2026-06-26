import { describe, expect, it, vi } from 'vitest'
import type { RunnerJobRef, RunnerJobView, RunnerTransport } from '@cat-factory/kernel'
import { NativeRoutingRunnerTransport } from './NativeRoutingRunnerTransport.js'

// The native-mode router sends only `ambientAuth` jobs (the developer's own CLI, run as a
// host process) to the process transport; everything else (proxy/`pi` models, non-native
// vendors reusing the claude-code harness) goes to the sandboxed per-run container.

function fakeTransport(name: string) {
  const t: RunnerTransport & { name: string } = {
    name,
    dispatch: vi.fn(async (_ref: RunnerJobRef, _spec, _kind) => {}),
    poll: vi.fn(async (_ref: RunnerJobRef): Promise<RunnerJobView> => ({ state: 'running' })),
    release: vi.fn(async (_ref: RunnerJobRef) => {}),
  }
  return t
}

describe('NativeRoutingRunnerTransport', () => {
  it('routes ambientAuth jobs to the process transport and the rest to the container transport', async () => {
    const ambient = fakeTransport('ambient')
    const managed = fakeTransport('managed')
    const router = new NativeRoutingRunnerTransport(
      () => ambient,
      () => managed,
    )

    await router.dispatch({ runId: 'r', jobId: 'native' }, { ambientAuth: true }, 'agent')
    await router.dispatch({ runId: 'r', jobId: 'proxy' }, { harness: 'pi' }, 'agent')

    expect(ambient.dispatch).toHaveBeenCalledTimes(1)
    expect(managed.dispatch).toHaveBeenCalledTimes(1)
    // poll/release reach the SAME backend the job dispatched to (per-job, so a mixed run works).
    await router.poll({ runId: 'r', jobId: 'native' })
    await router.poll({ runId: 'r', jobId: 'proxy' })
    expect(ambient.poll).toHaveBeenCalledTimes(1)
    expect(managed.poll).toHaveBeenCalledTimes(1)

    await router.release({ runId: 'r', jobId: 'proxy' })
    expect(managed.release).toHaveBeenCalledTimes(1)
    expect(ambient.release).not.toHaveBeenCalled()
  })

  it('builds each underlying transport lazily and only when its kind of job is dispatched', async () => {
    const ambientFactory = vi.fn(() => fakeTransport('ambient'))
    const managedFactory = vi.fn(() => fakeTransport('managed'))
    const router = new NativeRoutingRunnerTransport(ambientFactory, managedFactory)

    await router.dispatch({ runId: 'r', jobId: 'j' }, { ambientAuth: true }, 'agent')
    // A Claude/Codex-only native deployment never needs the container transport (no image).
    expect(ambientFactory).toHaveBeenCalled()
    expect(managedFactory).not.toHaveBeenCalled()
  })

  it('reports an eviction for an unknown ref (durable replay in a fresh process)', async () => {
    const router = new NativeRoutingRunnerTransport(
      () => fakeTransport('ambient'),
      () => fakeTransport('managed'),
    )
    const view = await router.poll({ runId: 'never', jobId: 'dispatched' })
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/evicted or crashed/)
  })
})
