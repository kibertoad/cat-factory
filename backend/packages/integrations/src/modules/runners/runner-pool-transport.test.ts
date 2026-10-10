import {
  DispatchError,
  type RunnerPoolManifest,
  type RunnerPoolProvider,
} from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { HttpRunnerPoolProvider, RunnerPoolApiError } from './HttpRunnerPoolProvider.js'
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
        return Promise.resolve('requested' as const)
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

  // A pool rejection's own wording (`Runner pool <method> → <status>`) matches no dispatch
  // check, so it used to be mislabelled a `preflight` failure downstream. Re-throwing it as a
  // structured DispatchError (carrying the pool's HTTP status) fixes the classification.
  it('re-throws a pool RunnerPoolApiError as a DispatchError carrying its HTTP status', async () => {
    const provider: RunnerPoolProvider = {
      dispatch: () => Promise.reject(new RunnerPoolApiError(502, 'Runner pool post → 502: down')),
      poll: () => Promise.resolve({ state: 'running' as const }),
      release: () => Promise.resolve('requested' as const),
    }
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    const err = await transport
      .dispatch({ runId: 'r', jobId: 'r-coder' }, {})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DispatchError)
    expect((err as DispatchError).status).toBe(502)
    expect((err as DispatchError).message).toContain('Runner pool post → 502')
  })

  it('wraps a non-status pool dispatch error as a DispatchError with status 0', async () => {
    const provider: RunnerPoolProvider = {
      dispatch: () => Promise.reject(new Error('network unreachable')),
      poll: () => Promise.resolve({ state: 'running' as const }),
      release: () => Promise.resolve('requested' as const),
    }
    const transport = new RunnerPoolTransport(provider, manifest, () => 't')
    const err = await transport
      .dispatch({ runId: 'r', jobId: 'r-coder' }, {})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DispatchError)
    expect((err as DispatchError).status).toBe(0)
    expect((err as DispatchError).message).toBe('network unreachable')
  })
})

// Shared by every suite below: hoisted to module scope when the one long `describe` was
// split into siblings, so each still sees the same fixtures (a module-level `beforeEach`
// runs for every suite in the file, exactly as the in-describe one did).
const POOL = 'https://pool.test'
let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  // Node's built-in `fetch` binds to its OWN bundled undici (v7 on Node 24), which ignores a
  // dispatcher set on the userland `undici` package (v8) — so the MockAgent above would be
  // silently bypassed and the provider would hit the REAL scheduler URL. Route the SUT's
  // `fetch` through the userland undici's fetch, which honours the dispatcher we set.
  vi.stubGlobal('fetch', undiciFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
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

describe('HttpRunnerPoolProvider — dispatch templating and view mapping', () => {
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

  it('forwards the harness liveness heartbeat when the manifest maps it', async () => {
    // Runtime symmetry: a pool that proxies the executor-harness verbatim must surface the
    // heartbeat just like a Cloudflare container, so a live-but-quiet pool run keeps its
    // `lastActivityAt` (and the run's `updated_at`) fresh instead of looking wedged.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      progress: { completed: 1, total: 5 },
      heartbeatAt: 1_700_000_123_456,
    })
    const provider = new HttpRunnerPoolProvider()
    const withHeartbeat: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, heartbeatPath: 'heartbeatAt' },
    }
    const view = await provider.poll({
      manifest: withHeartbeat,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })
    expect(view.state).toBe('running')
    expect(view.heartbeatAt).toBe(1_700_000_123_456)
  })

  it('omits the heartbeat when the manifest maps no path (absent ⇒ no liveness signal)', async () => {
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      heartbeatAt: 1_700_000_123_456,
    })
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.heartbeatAt).toBeUndefined()
  })

  it('maps the live bugfix reproduction proof when the manifest points at it', async () => {
    // Runtime symmetry: a pool that proxies the executor-harness verbatim must surface the
    // verdict WHILE the repair loop runs, exactly like a Cloudflare/local container. Absent the
    // mapping (below) a pool-backed bugfix PR would carry no reproduction section at all —
    // indistinguishable from a run that never declared one.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      reproductionReport: {
        status: 'reproduced',
        command: 'npm test -- repro',
        testPaths: ['a.test.ts'],
        attempts: 2,
        maxAttempts: 3,
        base: { exitCode: 1, passed: false, outputTail: 'BOOM', durationMs: 12, timedOut: false },
        final: { exitCode: 0, passed: true },
        at: 1_700_000_000_000,
      },
    })
    const provider = new HttpRunnerPoolProvider()
    const withProof: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, reproductionReportPath: 'reproductionReport' },
    }
    const view = await provider.poll({
      manifest: withProof,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.reproductionReport?.status).toBe('reproduced')
    expect(view.reproductionReport?.attempts).toBe(2)
    expect(view.reproductionReport?.base).toEqual({
      exitCode: 1,
      passed: false,
      outputTail: 'BOOM',
      durationMs: 12,
    })
    expect(view.reproductionReport?.final?.passed).toBe(true)
  })

  it('reads an UNRECOGNISED verdict as `inconclusive`, never as proof', async () => {
    // The status reaches a pull request as a statement about a defect. The safe reading of "I do
    // not know what this says" is that nothing was demonstrated — a scheduler that invents a
    // status must not be able to launder it into `reproduced`.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      reproductionReport: { status: 'totally-fine', command: 'npm test', testPaths: 'nope' },
    })
    const provider = new HttpRunnerPoolProvider()
    const withProof: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, reproductionReportPath: 'reproductionReport' },
    }
    const view = await provider.poll({
      manifest: withProof,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.reproductionReport?.status).toBe('inconclusive')
    // A non-array `testPaths` degrades to empty rather than failing the whole poll.
    expect(view.reproductionReport?.testPaths).toEqual([])
    expect(view.reproductionReport?.base).toBeUndefined()
  })

  it('injects nothing when the manifest maps no reproduction path, or the envelope is unusable', async () => {
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      reproductionReport: { status: 'reproduced', command: 'npm test' },
    })
    const provider = new HttpRunnerPoolProvider()
    const unmapped = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(unmapped.reproductionReport).toBeUndefined()

    // Mapped, but the envelope names no command — nothing report-shaped to coerce.
    capture('/api/jobs/job-8', 'GET', { state: 'in_progress', reproductionReport: { status: 'x' } })
    const withProof: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, reproductionReportPath: 'reproductionReport' },
    }
    const malformed = await provider.poll({
      manifest: withProof,
      jobId: 'job-8',
      resolveSecret: () => 't',
    })
    expect(malformed.reproductionReport).toBeUndefined()
  })

  it('maps the live per-slice PR reviews when the manifest points at them', async () => {
    // Unlike the two reports above, this channel is the ONLY thing that makes a finished slice
    // durable before the reviewer's terminal output. Without the mapping a pool-backed review that
    // wedges or dies has nothing for a manual resume to work from and can only be re-run from zero.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      sliceReviews: [
        { label: 'api-correlation', status: 'completed', report: 'Found an N+1.' },
        { label: 'infra-logging', status: 'in_progress' },
      ],
    })
    const provider = new HttpRunnerPoolProvider()
    const withSlices: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, sliceReviewsPath: 'sliceReviews' },
    }
    const view = await provider.poll({
      manifest: withSlices,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.sliceReviews).toEqual([
      { label: 'api-correlation', status: 'completed', report: 'Found an N+1.' },
      { label: 'infra-logging', status: 'in_progress' },
    ])
  })

  it('keeps the good slices beside a malformed one and never invents a `completed`', async () => {
    // Per-entry leniency, because discarding the valid reports is the exact data loss this channel
    // prevents. And an unrecognised status reads as `in_progress`: over-reporting `completed` would
    // make a resume SKIP a slice nobody reviewed, while the other direction only costs a re-review.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      sliceReviews: [
        { label: 'api', status: 'finished-ish', report: 'body' },
        { nonsense: true },
        { label: '   ', status: 'completed' },
        'not an object',
        { label: 'docs', status: 'completed', report: 42 },
      ],
    })
    const provider = new HttpRunnerPoolProvider()
    const withSlices: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, sliceReviewsPath: 'sliceReviews' },
    }
    const view = await provider.poll({
      manifest: withSlices,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.sliceReviews).toEqual([
      { label: 'api', status: 'in_progress', report: 'body' },
      // A non-string report is dropped rather than coerced; the slice still counts as reviewed.
      { label: 'docs', status: 'completed' },
    ])
  })

  it('injects nothing when the manifest maps no slice path, or the set is empty', async () => {
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      sliceReviews: [{ label: 'api', status: 'completed' }],
    })
    const provider = new HttpRunnerPoolProvider()
    const unmapped = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(unmapped.sliceReviews).toBeUndefined()

    capture('/api/jobs/job-8', 'GET', { state: 'in_progress', sliceReviews: [] })
    const withSlices: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, sliceReviewsPath: 'sliceReviews' },
    }
    const empty = await provider.poll({
      manifest: withSlices,
      jobId: 'job-8',
      resolveSecret: () => 't',
    })
    expect(empty.sliceReviews).toBeUndefined()
  })

  it('maps the CLI-observed tool servers when the manifest points at them', async () => {
    // The pool leg of the observation channel. Everything downstream pairs a row to the dispatch's
    // own record by id alone, so what this coercion gets wrong is invisible until a step detail
    // accuses a healthy server.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      toolServers: [
        { id: 'slack', status: 'ready', toolCount: 4 },
        // `0` is the most diagnostic count there is: connected, and exposing nothing.
        { id: 'jira', status: 'ready', toolCount: 0 },
        { id: 'sentry', status: 'failed' },
      ],
    })
    const provider = new HttpRunnerPoolProvider()
    const withServers: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, toolServersPath: 'toolServers' },
    }
    const view = await provider.poll({
      manifest: withServers,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.toolServers).toEqual([
      { id: 'slack', status: 'ready', toolCount: 4 },
      { id: 'jira', status: 'ready', toolCount: 0 },
      { id: 'sentry', status: 'failed' },
    ])
  })

  it('trims a padded id and reads an unmappable status as unknown rather than dropping the row', async () => {
    // The id is the ONLY key the engine pairs an observation to the dispatch's declaration by, and
    // it pairs by exact string. A padded id that survives verbatim renders one healthy server as
    // two faults at once: never-loaded on the wired chip, and unattributed beside it.
    //
    // A status this deployment cannot name stays as a row: dropping it reads as a server the CLI
    // never loaded, which is a different fault with a different fix.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      toolServers: [
        { id: '  slack  ', status: 'ready', toolCount: 2 },
        { id: 'jira', status: 'reticulating' },
        { id: '   ' },
        { id: 42, status: 'ready' },
        'not an object',
        // A count that is not a usable number leaves the field absent, never 0.
        { id: 'sentry', status: 'ready', toolCount: -1 },
        { id: 'linear', status: 'ready', toolCount: 'many' },
      ],
    })
    const provider = new HttpRunnerPoolProvider()
    const withServers: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, toolServersPath: 'toolServers' },
    }
    const view = await provider.poll({
      manifest: withServers,
      jobId: 'job-7',
      resolveSecret: () => 't',
    })

    expect(view.toolServers).toEqual([
      { id: 'slack', status: 'ready', toolCount: 2 },
      { id: 'jira', status: 'unknown' },
      { id: 'sentry', status: 'ready' },
      { id: 'linear', status: 'ready' },
    ])
  })

  it('injects nothing when the manifest maps no tool-server path, or the set is empty', async () => {
    // The absent-vs-empty rule this whole channel rests on: a pool that has not mapped the path
    // must leave the record ABSENT, because an empty list reads as "the CLI loaded none of the
    // servers the platform wired" on a run whose servers were fine.
    capture('/api/jobs/job-7', 'GET', {
      state: 'in_progress',
      toolServers: [{ id: 'slack', status: 'ready' }],
    })
    const provider = new HttpRunnerPoolProvider()
    const unmapped = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(unmapped.toolServers).toBeUndefined()

    capture('/api/jobs/job-8', 'GET', { state: 'in_progress', toolServers: [] })
    const withServers: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, toolServersPath: 'toolServers' },
    }
    const empty = await provider.poll({
      manifest: withServers,
      jobId: 'job-8',
      resolveSecret: () => 't',
    })
    expect(empty.toolServers).toBeUndefined()
  })
})

describe('HttpRunnerPoolProvider — failure, eviction and result mapping', () => {
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

  for (const status of [404, 410]) {
    it(`reports a job the scheduler no longer knows (${status}) as an EVICTION, not a poll fault`, async () => {
      // A pool member dying mid-job leaves the scheduler 404ing (or 410ing) its id. Without this
      // mapping the throw counts against the engine's poll-failure tolerance and the run dies
      // `timeout` without ever trying a fresh member; the structured `evicted` field is what
      // engages the engine's re-dispatch recovery.
      capture('/api/jobs/job-7', 'GET', { message: 'no such job' }, status)
      const provider = new HttpRunnerPoolProvider()
      const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
      expect(view.state).toBe('failed')
      expect(view.evicted).toBe('crash')
      expect(view.error).toContain('container evicted or crashed')
      // The status LEADS, and the scheduler's own account rides `detail`: a 404 also covers a
      // mistyped poll path and a scheduler that 404s an unauthorized read, and an operator
      // handed a bare "container evicted or crashed" has nothing to act on. The detail carries
      // the provider's fix-it remedy (its error message), which names where to correct it.
      expect(view.error).toContain(`Runner pool poll → ${status}`)
      expect(view.detail).toContain('Settings')
    })
  }

  it('still throws on a non-404 poll fault (a broken scheduler is not an eviction)', async () => {
    // A 500 says the SCHEDULER is unwell, not that the job is gone: re-dispatching onto a
    // fresh member would be wrong, so it stays a throw for the poll-failure tolerance to bound.
    capture('/api/jobs/job-7', 'GET', { message: 'upstream exploded' }, 500)
    const provider = new HttpRunnerPoolProvider()
    await expect(
      provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' }),
    ).rejects.toBeInstanceOf(RunnerPoolApiError)
  })

  it('tags a reclaimed-runner status as an eviction so a fresh member is tried', async () => {
    capture('/api/jobs/job-7', 'GET', { state: 'preempted' })
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBe('crash')
    // No `errorPath` value in the response, so the provider explains the loss itself.
    expect(view.error).toContain('preempted')
  })

  it('leaves `evicted` unset on an ordinary job failure', async () => {
    capture('/api/jobs/job-7', 'GET', { state: 'errored', error: 'tests failed' })
    const provider = new HttpRunnerPoolProvider()
    const view = await provider.poll({ manifest, jobId: 'job-7', resolveSecret: () => 't' })
    expect(view.state).toBe('failed')
    expect(view.evicted).toBeUndefined()
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

  it('forwards a subscription harness’s per-call telemetry (callMetrics)', async () => {
    // Claude Code / Codex bypass the LLM proxy, so the harness lifts per-call metrics onto
    // `result.callMetrics` for the backend to record into `llm_call_metrics`. The
    // Cloudflare/local transports return the harness view verbatim, so a pool proxying the
    // executor-harness MUST pass `callMetrics` through too — dropping it silently lost ALL
    // harness telemetry on a runner-pool backend (a facade-parity divergence). A malformed
    // entry is discarded rather than injected.
    const good = {
      model: 'claude-opus-4-8',
      promptText: '[{"role":"user","content":"u"}]',
      messageCount: 1,
      responseText: 'hi',
      reasoningText: '',
      inputTokens: 120,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      outputTokens: 30,
      finishReason: 'end_turn',
    }
    capture('/api/jobs/job-9', 'GET', {
      state: 'succeeded',
      result: {
        summary: 'coded',
        callMetrics: [good, { promptText: 'not a full metric' }],
      },
    })
    const provider = new HttpRunnerPoolProvider()
    const withResult: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, resultPath: 'result' },
    }
    const view = await provider.poll({
      manifest: withResult,
      jobId: 'job-9',
      resolveSecret: () => 't',
    })
    expect(view.state).toBe('done')
    // The well-formed entry survives with every field; the malformed one is dropped.
    expect(view.result?.callMetrics).toEqual([good])
  })

  it('keeps call telemetry from a harness image that predates the cache-class split', async () => {
    // A pool runs whatever harness image its WORKSPACE pinned, so an image older than the
    // fresh/read/write split is a normal operating state, not a malformed envelope. Its
    // entries carry no cache fields; requiring them would fail every entry and drop ALL of
    // that pool's telemetry silently — the run would report zero model calls rather than
    // "cache breakdown unknown". The call, its tokens and its bodies must survive, with the
    // split it never measured reading as 0.
    const legacy = {
      model: 'claude-opus-4-8',
      promptText: '[{"role":"user","content":"u"}]',
      messageCount: 1,
      responseText: 'hi',
      reasoningText: '',
      inputTokens: 120,
      outputTokens: 30,
      finishReason: 'end_turn',
    }
    capture('/api/jobs/job-9b', 'GET', {
      state: 'succeeded',
      result: { summary: 'coded', callMetrics: [legacy] },
    })
    const provider = new HttpRunnerPoolProvider()
    const withResult: RunnerPoolManifest = {
      ...manifest,
      response: { ...manifest.response, resultPath: 'result' },
    }
    const view = await provider.poll({
      manifest: withResult,
      jobId: 'job-9b',
      resolveSecret: () => 't',
    })
    expect(view.result?.callMetrics).toEqual([
      { ...legacy, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ])
  })

  // D2: every runner-pool failure carries the UI-first remedy naming where the pool is
  // configured/re-tested — while PRESERVING the raw `<method> → <status>` diagnostic ahead of it.
  it('appends the UI-first remedy to every RunnerPoolApiError while preserving the raw detail', () => {
    const err = new RunnerPoolApiError(403, 'Runner pool post → 403: forbidden')
    expect(err.status).toBe(403)
    expect(err.message).toContain('Runner pool post → 403: forbidden')
    expect(err.message).toContain('Settings → Self-hosted runner pool')
    expect(err.message).toContain('runner-pool-integration.md')
    // A manifest-secret failure gets the same remedy.
    expect(new RunnerPoolApiError(500, "Missing secret 'API_TOKEN'").message).toContain(
      'Settings → Self-hosted runner pool',
    )
  })
})

describe('HttpRunnerPoolProvider and the harness capability handshake', () => {
  /** The manifest a pool that PROXIES `POST /jobs` verbatim would author: one mapped path. */
  const mapped: RunnerPoolManifest = {
    ...manifest,
    response: { ...manifest.response, dispatchCapabilitiesPath: 'capabilities' },
  }

  const dispatch = (m: RunnerPoolManifest) =>
    new HttpRunnerPoolProvider().dispatch({
      manifest: m,
      jobId: 'job-7',
      spec: {},
      resolveSecret: () => 'secret-token',
    })

  it('reads the handshake when the manifest says where it is', async () => {
    capture('/api/jobs', 'POST', { id: 'job-7', capabilities: ['mcpServers', 'skills'] }, 202)
    expect(await dispatch(mapped)).toEqual({ capabilities: ['mcpServers', 'skills'] })
  })

  it('reads a NESTED path, since a scheduler wraps the harness body where it likes', async () => {
    capture('/api/jobs', 'POST', { runner: { ack: { capabilities: ['skills'] } } }, 202)
    expect(
      await dispatch({
        ...manifest,
        response: { ...manifest.response, dispatchCapabilitiesPath: 'runner.ack.capabilities' },
      }),
    ).toEqual({ capabilities: ['skills'] })
  })

  it("IGNORES a scheduler's own `capabilities` when the manifest maps nothing", async () => {
    // The regression this mapping exists for. `capabilities` is an ordinary word for a scheduler
    // to use about its own runners, and reading one of those as the harness\'s answer narrows to
    // an EMPTY list, which downstream is `unsupported`: a hard refusal of every capability
    // dispatch against a perfectly current image. Unmapped must mean "could not tell".
    capture('/api/jobs', 'POST', { id: 'job-7', capabilities: ['gpu', 'docker'] }, 202)
    expect(await dispatch(manifest)).toBeUndefined()
  })

  it('answers undefined when the mapped path holds nothing usable', async () => {
    // A pool that mapped the path against a scheduler that later changed shape must degrade to
    // "could not tell", never to an empty list.
    capture('/api/jobs', 'POST', { id: 'job-7' }, 202)
    expect(await dispatch(mapped)).toBeUndefined()
  })
})

describe('HttpRunnerPoolProvider.release reports whether it cancelled anything', () => {
  it('is `requested` when the manifest declares a release template', async () => {
    // The strongest honest answer: the scheduler took the call, and nothing this side of the
    // pool\'s control plane can see whether the runner obeyed.
    const seen = capture('/api/jobs/job-7', 'DELETE', {}, 200)
    const provider = new HttpRunnerPoolProvider()
    expect(await provider.release({ manifest, jobId: 'job-7', resolveSecret: () => 't' })).toBe(
      'requested',
    )
    expect(seen).toHaveLength(1)
  })

  it('is `unsupported` when it declares none, rather than a silent success', async () => {
    // This same call is the pool\'s only CANCEL. A void return here read as a stopped job, which
    // is how a refused blind run kept working against the repository with nobody told.
    const { release: _release, ...noRelease } = manifest
    const provider = new HttpRunnerPoolProvider()
    expect(
      await provider.release({ manifest: noRelease, jobId: 'job-7', resolveSecret: () => 't' }),
    ).toBe('unsupported')
  })
})
