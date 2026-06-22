import type { RunnerPoolManifest, RunnerPoolProvider } from '@cat-factory/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRunnerPoolProvider } from './HttpRunnerPoolProvider.js'
import { RunnerPoolTransport } from './RunnerPoolTransport.js'

// The runtime-neutral self-hosted runner-pool transport both facades resolve for a
// workspace's pool: the per-job RunnerTransport adapter and the generic manifest
// interpreter that drives an org's scheduler over HTTP.

const manifest: RunnerPoolManifest = {
  providerId: 'acme-pool',
  label: 'Acme',
  baseUrl: 'https://pool.test/api',
  auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
  dispatch: {
    method: 'POST',
    pathTemplate: '/jobs',
    bodyTemplate: '{"id":"{{input.jobId}}","job":{{input.job}}}',
  },
  poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
  release: { method: 'DELETE', pathTemplate: '/jobs/{{input.jobId}}' },
  response: {
    statusPath: 'state',
    statusMap: [
      { from: 'in_progress', to: 'running' },
      { from: 'succeeded', to: 'done' },
      { from: 'errored', to: 'failed' },
    ],
    progressCompletedPath: 'progress.completed',
    progressTotalPath: 'progress.total',
    prUrlPath: 'result.pr_url',
    summaryPath: 'result.summary',
    errorPath: 'error',
  },
}

describe('RunnerPoolTransport', () => {
  function fakeProvider() {
    const calls: { dispatch: unknown[]; poll: unknown[]; release: unknown[] } = {
      dispatch: [],
      poll: [],
      release: [],
    }
    const provider: RunnerPoolProvider = {
      dispatch: (req) => {
        calls.dispatch.push(req)
        return Promise.resolve()
      },
      poll: (req) => {
        calls.poll.push(req)
        return Promise.resolve({ state: 'running' as const })
      },
      release: (req) => {
        calls.release.push(req)
        return Promise.resolve()
      },
    }
    return { provider, calls }
  }

  it('delegates dispatch/poll/release to the provider with the bound manifest', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, (k) =>
      k === 'API_TOKEN' ? 't' : undefined,
    )
    await transport.dispatch('job-1', { hello: 'world' }, 'run')
    await transport.poll('job-1')
    await transport.release('job-1')
    expect(calls.dispatch).toHaveLength(1)
    expect(calls.poll).toHaveLength(1)
    expect(calls.release).toHaveLength(1)
  })

  it('serves repo bootstrap (the harness /bootstrap route needs no Cloudflare primitive)', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    await transport.dispatch('job-1', { repoName: 'svc' }, 'bootstrap')
    expect(calls.dispatch).toHaveLength(1)
    const req = calls.dispatch[0] as { spec: Record<string, unknown> }
    expect(req.spec.kind).toBe('bootstrap')
  })

  it('rejects the Cloudflare-only kinds (self-hosted pools serve run/test/fix/bootstrap only)', () => {
    const { provider } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    expect(() => transport.dispatch('job-1', {}, 'blueprint')).toThrow(/do not support 'blueprint'/)
    expect(() => transport.dispatch('job-1', {}, 'merge')).toThrow(/do not support 'merge'/)
  })
})

describe('HttpRunnerPoolProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('interpolates the dispatch body + bearer auth and forwards the job spec', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Promise.resolve(new Response('{}', { status: 202 }))
    })
    const provider = new HttpRunnerPoolProvider()
    await provider.dispatch({
      manifest,
      jobId: 'job-7',
      spec: { model: 'qwen' },
      resolveSecret: (k) => (k === 'API_TOKEN' ? 'secret-token' : undefined),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://pool.test/api/jobs')
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token',
    )
    expect(seen[0]!.init.body).toBe('{"id":"job-7","job":{"model":"qwen"}}')
  })

  it('maps the scheduler status response onto the canonical job view', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            state: 'succeeded',
            progress: { completed: 3, total: 5 },
            result: { pr_url: 'https://github.com/o/r/pull/9', summary: 'done' },
          }),
          { status: 200 },
        ),
      ),
    )
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.state).toBe('done')
    expect(view.progress).toEqual({ completed: 3, inProgress: 0, total: 5 })
    expect(view.result?.prUrl).toBe('https://github.com/o/r/pull/9')
  })
})
