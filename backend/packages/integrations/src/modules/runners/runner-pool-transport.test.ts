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
    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-coder' }, { hello: 'world' }, 'run')
    await transport.poll({ runId: 'run-1', jobId: 'run-1-coder' })
    await transport.release({ runId: 'run-1', jobId: 'run-1-coder' })
    expect(calls.dispatch).toHaveLength(1)
    expect(calls.poll).toHaveLength(1)
    expect(calls.release).toHaveLength(1)
    // A pool is per-job (no shared per-run container), so it keys on the per-step job
    // id — `runId` is irrelevant to it. This is what keeps sibling steps distinct here.
    expect((calls.dispatch[0] as { jobId: string }).jobId).toBe('run-1-coder')
    expect((calls.poll[0] as { jobId: string }).jobId).toBe('run-1-coder')
    expect((calls.release[0] as { jobId: string }).jobId).toBe('run-1-coder')
  })

  it('serves repo bootstrap (the harness /bootstrap route needs no Cloudflare primitive)', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, { repoName: 'svc' }, 'bootstrap')
    expect(calls.dispatch).toHaveLength(1)
    const req = calls.dispatch[0] as { spec: Record<string, unknown> }
    expect(req.spec.kind).toBe('bootstrap')
  })

  // Runtime parity is the default: a pool runs the same harness image, so it serves
  // every kind with no opt-in allow-list — none are gated or rejected.
  it('serves every harness route (blueprint/spec/merge/… run on the same image)', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    for (const kind of [
      'blueprint',
      'spec',
      'explore',
      'ci-fix',
      'resolve-conflicts',
      'merge',
      'test',
      'fix-tests',
    ] as const) {
      await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {}, kind)
    }
    expect(calls.dispatch).toHaveLength(8)
    expect((calls.dispatch.at(-1) as { spec: Record<string, unknown> }).spec.kind).toBe('fix-tests')
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

  it('exposes kind + provisioning hints as first-class template variables', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Promise.resolve(new Response('{}', { status: 202 }))
    })
    // A manifest that routes straight to a per-kind harness endpoint and forwards the
    // sizing hints, all without parsing the embedded `{{input.job}}` JSON.
    const routed: RunnerPoolManifest = {
      ...manifest,
      dispatch: {
        method: 'POST',
        pathTemplate: '/{{input.kind}}',
        bodyTemplate: '{"id":"{{input.jobId}}","size":"{{input.instanceType}}"}',
      },
    }
    const provider = new HttpRunnerPoolProvider()
    await provider.dispatch({
      manifest: routed,
      jobId: 'job-7',
      // The shape RunnerPoolTransport stamps: `kind` always, the hints when pinned.
      spec: { model: 'qwen', kind: 'merge', instanceType: 'c7g.large', cloudProvider: 'aws' },
      resolveSecret: (k) => (k === 'API_TOKEN' ? 'secret-token' : undefined),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://pool.test/api/merge')
    expect(seen[0]!.init.body).toBe('{"id":"job-7","size":"c7g.large"}')
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

  it('forwards the whole structured result envelope via resultPath (test report, etc.)', async () => {
    const report = {
      greenlight: false,
      summary: 'two checks failed',
      tested: ['login'],
      outcomes: [{ name: 'login', status: 'failed' }],
      concerns: [{ title: 'bug', detail: 'x', severity: 'high' }],
    }
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            state: 'succeeded',
            result: { report, summary: 'tested', usage: { inputTokens: 10, outputTokens: 5 } },
          }),
          { status: 200 },
        ),
      ),
    )
    const provider = new HttpRunnerPoolProvider()
    const withResult: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, resultPath: 'result' },
    }
    const view = await provider.poll({
      manifest: withResult,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })
    expect(view.state).toBe('done')
    // The structured test report reaches the engine intact (previously dropped).
    expect(view.result?.report).toEqual(report)
    expect(view.result?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(view.result?.summary).toBe('tested')
  })

  it('forwards the generic `custom` structured channel (migrated agent kinds)', async () => {
    // The migrated, manifest-driven `agent` kinds (blueprints / spec-writer / merger /
    // on-call) return their structured doc on `result.custom`; `toRunResult` coerces it
    // backend-side. The Cloudflare/local transports return the harness view verbatim, so
    // the pool provider MUST pass `custom` through too — dropping it silently lost the
    // doc on a runner-pool backend (a facade-parity divergence).
    const custom = { service: 'Widgets', summary: 'A widget service.', modules: [] }
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ state: 'succeeded', result: { custom, summary: 'wrote the spec' } }),
          { status: 200 },
        ),
      ),
    )
    const provider = new HttpRunnerPoolProvider()
    const withResult: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, resultPath: 'result' },
    }
    const view = await provider.poll({
      manifest: withResult,
      jobId: 'job-8',
      resolveSecret: () => 't',
    })
    expect(view.state).toBe('done')
    expect(view.result?.custom).toEqual(custom)
    expect(view.result?.summary).toBe('wrote the spec')
  })
})
