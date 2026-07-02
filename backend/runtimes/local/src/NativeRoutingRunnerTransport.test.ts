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

  it('falls back to the container transport for an unknown ref (a restart survivor lives there)', async () => {
    // After an orchestrator restart the routing map is empty, but a per-run CONTAINER job
    // may still be running (the container transport re-finds it by label). The ambient host
    // process died with the parent, so the managed leg is the only place a survivor can be.
    const ambient = fakeTransport('ambient')
    const managed = fakeTransport('managed')
    const router = new NativeRoutingRunnerTransport(
      () => ambient,
      () => managed,
    )
    const view = await router.poll({ runId: 'restarted', jobId: 'container-job' })
    expect(view.state).toBe('running')
    expect(managed.poll).toHaveBeenCalledTimes(1)
    expect(ambient.poll).not.toHaveBeenCalled()
    // The fallback route is remembered for subsequent polls.
    await router.poll({ runId: 'restarted', jobId: 'container-job' })
    expect(managed.poll).toHaveBeenCalledTimes(2)
  })

  it('reports an eviction for an unknown ref when no container transport can be built', async () => {
    // A Claude/Codex-only native deployment has no container leg (no image configured);
    // the unknown-ref fallback must degrade to the eviction view, not throw.
    const router = new NativeRoutingRunnerTransport(
      () => fakeTransport('ambient'),
      () => {
        throw new Error('no LOCAL_HARNESS_IMAGE')
      },
    )
    const view = await router.poll({ runId: 'never', jobId: 'dispatched' })
    expect(view.state).toBe('failed')
    expect(view.error).toMatch(/evicted or crashed/)
  })

  it('falls back to the container transport for an unknown ref on release (cold cancel after restart)', async () => {
    // A cold release after a restart (run cancelled before any poll re-routed the ref) must not
    // no-op: a survivor is a per-run container the managed leg re-finds by label, so release has
    // to reach it to tear it down instead of leaking a still-running container.
    const ambient = fakeTransport('ambient')
    const managed = fakeTransport('managed')
    const router = new NativeRoutingRunnerTransport(
      () => ambient,
      () => managed,
    )
    await router.release({ runId: 'restarted', jobId: 'container-job' })
    expect(managed.release).toHaveBeenCalledTimes(1)
    expect(ambient.release).not.toHaveBeenCalled()
  })

  it('release for an unknown ref degrades to a no-op when no container transport can be built', async () => {
    const router = new NativeRoutingRunnerTransport(
      () => fakeTransport('ambient'),
      () => {
        throw new Error('no LOCAL_HARNESS_IMAGE')
      },
    )
    // Claude/Codex-only native deployment: nothing to release, and it must not throw.
    await expect(router.release({ runId: 'never', jobId: 'dispatched' })).resolves.toBeUndefined()
  })

  it('drops the remembered route when a poll reports the job evicted', async () => {
    const ambient = fakeTransport('ambient')
    ambient.poll = vi.fn(
      async (): Promise<RunnerJobView> => ({
        state: 'failed',
        error: 'Job not found (container evicted or crashed)',
      }),
    )
    const managed = fakeTransport('managed')
    const router = new NativeRoutingRunnerTransport(
      () => ambient,
      () => managed,
    )
    await router.dispatch({ runId: 'r', jobId: 'j' }, { ambientAuth: true }, 'agent')
    const view = await router.poll({ runId: 'r', jobId: 'j' })
    expect(view.state).toBe('failed')
    // The route was dropped: the next poll takes the unknown-ref fallback (managed leg)
    // instead of re-polling the ambient transport forever.
    await router.poll({ runId: 'r', jobId: 'j' })
    expect(managed.poll).toHaveBeenCalledTimes(1)
    expect(ambient.poll).toHaveBeenCalledTimes(1)
  })
})
