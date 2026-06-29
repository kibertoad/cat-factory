import type { RunnerPoolManifest, RunnerPoolProvider } from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
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
    await transport.dispatch({ runId: 'run-1', jobId: 'run-1-coder' }, { hello: 'world' }, 'agent')
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

  it('stamps the dispatch spec with the single generic agent kind', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, { repoName: 'svc' }, 'agent')
    expect(calls.dispatch).toHaveLength(1)
    const req = calls.dispatch[0] as { spec: Record<string, unknown> }
    expect(req.spec.kind).toBe('agent')
  })

  // The harness is a generic LLM-over-a-checkout runner with ONE route: WHAT each agent
  // does (bootstrap, conflict resolution, blueprint, merge, …) is carried as job data, not
  // a separate dispatch kind. A pool runs the same image, so dispatch defaults to `agent`.
  it('defaults the dispatch kind to the generic agent route', async () => {
    const { provider, calls } = fakeProvider()
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    await transport.dispatch({ runId: 'job-1', jobId: 'job-1' }, {})
    expect(calls.dispatch).toHaveLength(1)
    expect((calls.dispatch[0] as { spec: Record<string, unknown> }).spec.kind).toBe('agent')
  })
})

describe('HttpRunnerPoolProvider', () => {
  // The provider drives the org's scheduler over the global `fetch`; intercept that real fetch
  // with undici's MockAgent (instead of replacing `fetch` wholesale via `vi.stubGlobal`), so the
  // real URL building, header casing and Response parsing are exercised. `disableNetConnect`
  // makes any un-mocked request fail loudly.
  const POOL = 'https://pool.test'
  let agent: MockAgent
  let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher()
    agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
  })

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher)
    await agent.close()
  })

  interface SeenRequest {
    url: string
    headers: Record<string, string>
    body: string
  }

  /** Record requests matching path+method (reconstructing the full URL), replying with `json`. */
  function capture(path: string, method: string, json: unknown, status = 200): SeenRequest[] {
    const seen: SeenRequest[] = []
    agent
      .get(POOL)
      .intercept({ path, method })
      .reply(status, (opts) => {
        seen.push({
          url: `${POOL}${opts.path}`,
          headers: opts.headers as Record<string, string>,
          body: opts.body ? String(opts.body) : '',
        })
        return typeof json === 'string' ? json : JSON.stringify(json)
      })
    return seen
  }

  it('interpolates the dispatch body + bearer auth and forwards the job spec', async () => {
    const seen = capture('/api/jobs', 'POST', {}, 202)
    const provider = new HttpRunnerPoolProvider()
    await provider.dispatch({
      manifest,
      jobId: 'job-7',
      spec: { model: 'qwen' },
      resolveSecret: (k) => (k === 'API_TOKEN' ? 'secret-token' : undefined),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://pool.test/api/jobs')
    expect(seen[0]!.headers.authorization).toBe('Bearer secret-token')
    expect(seen[0]!.body).toBe('{"id":"job-7","job":{"model":"qwen"}}')
  })

  it('exposes kind + provisioning hints as first-class template variables', async () => {
    const seen = capture('/api/merge', 'POST', {}, 202)
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
    expect(seen[0]!.body).toBe('{"id":"job-7","size":"c7g.large"}')
  })

  it('maps the scheduler status response onto the canonical job view', async () => {
    capture('/api/jobs/job-7', 'GET', {
      state: 'succeeded',
      progress: { completed: 3, total: 5 },
      result: { pr_url: 'https://github.com/o/r/pull/9', summary: 'done' },
    })
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.state).toBe('done')
    expect(view.progress).toEqual({ completed: 3, inProgress: 0, total: 5 })
    expect(view.result?.prUrl).toBe('https://github.com/o/r/pull/9')
  })

  it('forwards the harness failureCause + detail on a failed view when the manifest maps them', async () => {
    // Runtime symmetry: a pool that proxies the executor-harness verbatim must surface the
    // STRUCTURED cause/detail just like a Cloudflare container, so the engine classifies the
    // failure without regex. Absent the manifest paths (below) it stays a bare error.
    capture('/api/jobs/job-7', 'GET', {
      state: 'errored',
      error: 'Aborted: no agent activity for 600s (likely hung in agent phase)',
      failureCause: 'inactivity-timeout',
      detail: 'Phase timings: clone=2s, agent=600s.',
    })
    const provider = new HttpRunnerPoolProvider()
    const withCause: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, failureCausePath: 'failureCause', detailPath: 'detail' },
    }
    const view = await provider.poll({
      manifest: withCause,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })
    expect(view.state).toBe('failed')
    expect(view.failureCause).toBe('inactivity-timeout')
    expect(view.detail).toBe('Phase timings: clone=2s, agent=600s.')
  })

  it('leaves failureCause/detail unset when the manifest does not map them (older pool)', async () => {
    capture('/api/jobs/job-7', 'GET', { state: 'errored', error: 'boom' })
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.state).toBe('failed')
    expect(view.error).toBe('boom')
    expect(view.failureCause).toBeUndefined()
    expect(view.detail).toBeUndefined()
  })

  it('forwards the slimmed result scalars via resultPath and drops legacy structured fields', async () => {
    // The bespoke per-kind result channels (`report`/`service`/`assessment`/`resolved`/…)
    // were removed when every built-in agent migrated onto the single `agent` kind — its
    // structured doc now rides `custom` (covered below). A pool that still returns an old
    // `report` field has it dropped (not a known channel); the scalars pass through.
    capture('/api/jobs/job-7', 'GET', {
      state: 'succeeded',
      result: {
        report: { greenlight: false },
        pushed: true,
        summary: 'tested',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    })
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
    expect(view.result?.summary).toBe('tested')
    expect(view.result?.pushed).toBe(true)
    expect(view.result?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    // The legacy `report` channel no longer exists on the result, so it is dropped.
    expect((view.result as Record<string, unknown>).report).toBeUndefined()
  })

  it('forwards the generic `custom` structured channel (migrated agent kinds)', async () => {
    // The migrated, manifest-driven `agent` kinds (blueprints / spec-writer / merger /
    // on-call) return their structured doc on `result.custom`; `toRunResult` coerces it
    // backend-side. The Cloudflare/local transports return the harness view verbatim, so
    // the pool provider MUST pass `custom` through too — dropping it silently lost the
    // doc on a runner-pool backend (a facade-parity divergence).
    const custom = { service: 'Widgets', summary: 'A widget service.', modules: [] }
    capture('/api/jobs/job-8', 'GET', {
      state: 'succeeded',
      result: { custom, summary: 'wrote the spec' },
    })
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
