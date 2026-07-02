import { describe, expect, it } from 'vitest'
import type { ContainerEndpoint, ContainerExec, ContainerRuntimeAdapter } from './runtimes/index.js'
import { LocalPreviewTransport } from './LocalPreviewTransport.js'

// A minimal fake adapter: one container, an 8080 harness endpoint + a per-port map for the
// published serve port, and running-state/removal tracking.
function fakeAdapter(overrides: Partial<ContainerRuntimeAdapter> = {}): {
  adapter: ContainerRuntimeAdapter
  removed: string[]
  runs: Array<{ runId: string; publishPorts?: number[] }>
} {
  const removed: string[] = []
  const runs: Array<{ runId: string; publishPorts?: number[] }> = []
  const adapter: ContainerRuntimeAdapter = {
    id: 'docker',
    binary: 'docker',
    capabilities: { localDind: true, pooling: true },
    hostAlias: 'host.docker.internal',
    async run(_exec, spec) {
      runs.push({ runId: spec.runId, publishPorts: spec.publishPorts })
      return `cid-${spec.runId}`
    },
    async find(_exec, runId) {
      return `cid-${runId}`
    },
    async endpoint(_exec, _id, port = 8080): Promise<ContainerEndpoint | undefined> {
      // 8080 → the harness; the published serve port → a distinct ephemeral host port.
      return port === 8080 ? { host: '127.0.0.1', port: 18080 } : { host: '127.0.0.1', port: 54173 }
    },
    async isRunning() {
      return true
    },
    async logs() {
      return ''
    },
    async remove(_exec, id) {
      removed.push(id)
    },
    async removeRun(_exec, runId) {
      removed.push(runId)
    },
    async reapExited() {
      return 0
    },
    async listPoolMembers() {
      return []
    },
    async listRunContainers() {
      return []
    },
    ...overrides,
  }
  return { adapter, removed, runs }
}

const noopExec: ContainerExec = async () => ({ stdout: '', stderr: '' })

/** A fetch that is healthy and reports the single preview job as `done`. */
function okFetch(jobState: 'running' | 'done' | 'failed' = 'done'): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url.toString()
    if (href.endsWith('/health')) return new Response('ok', { status: 200 })
    if (href.includes('/jobs/')) {
      return new Response(JSON.stringify({ state: jobState }), { status: 200 })
    }
    // POST /jobs
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
}

function makeTransport(adapter: ContainerRuntimeAdapter, fetchImpl: typeof fetch) {
  return new LocalPreviewTransport({
    image: 'img:test',
    adapter,
    sharedSecret: 'sek',
    exec: noopExec,
    fetchImpl,
  })
}

const ref = { workspaceId: 'ws1', frameId: 'blk_fe' }

describe('LocalPreviewTransport', () => {
  it('starts a preview publishing the serve port and dispatches the build job', async () => {
    const { adapter, runs } = fakeAdapter()
    const transport = makeTransport(adapter, okFetch())
    await transport.start(ref, { jobId: 'preview', mode: 'preview' }, 4173)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.runId).toBe('preview-blk_fe')
    expect(runs[0]!.publishPorts).toEqual([4173])
  })

  it('reports the browsable host URL from the published serve port once serving', async () => {
    const { adapter } = fakeAdapter()
    const transport = makeTransport(adapter, okFetch('done'))
    await transport.start(ref, { jobId: 'preview', mode: 'preview' }, 4173)
    const view = await transport.poll(ref)
    // The URL is formed from the SERVE port's published host port (54173), not the harness (18080).
    expect(view).toEqual({ state: 'running', url: 'http://127.0.0.1:54173' })
  })

  it('reports `starting` while the build job is still running', async () => {
    const { adapter } = fakeAdapter()
    const transport = makeTransport(adapter, okFetch('running'))
    await transport.start(ref, { jobId: 'preview', mode: 'preview' }, 4173)
    expect(await transport.poll(ref)).toEqual({ state: 'starting' })
  })

  it('surfaces a failed build job', async () => {
    const { adapter } = fakeAdapter()
    const failFetch = (async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.endsWith('/health')) return new Response('ok', { status: 200 })
      if (href.includes('/jobs/')) {
        return new Response(JSON.stringify({ state: 'failed', error: 'build broke' }), {
          status: 200,
        })
      }
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const transport = makeTransport(adapter, failFetch)
    await transport.start(ref, { jobId: 'preview', mode: 'preview' }, 4173)
    expect(await transport.poll(ref)).toMatchObject({ state: 'failed', error: 'build broke' })
  })

  it('stops by removing the frame-keyed preview container', async () => {
    const { adapter, removed } = fakeAdapter()
    const transport = makeTransport(adapter, okFetch())
    await transport.start(ref, { jobId: 'preview', mode: 'preview' }, 4173)
    await transport.stop(ref)
    expect(removed).toContain('preview-blk_fe')
  })

  it('reports a vanished container as failed (evicted)', async () => {
    const { adapter } = fakeAdapter({
      find: async () => undefined,
    })
    const transport = makeTransport(adapter, okFetch())
    // No start (cache empty) + find returns nothing → treated as evicted.
    expect(await transport.poll(ref)).toMatchObject({ state: 'failed' })
  })
})
