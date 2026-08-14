import type {
  AgentJobHandle,
  AgentRunContext,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { createOperationalMetricsCollector } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import { containerJobLog } from '../src/agents/containerAgentLogging.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The workflow↔container seam. The durable driver knows a run as `executionId`; the harness knew
// it only as `jobId`, and the executor joining the two logged nothing at all — so a run that
// stopped moving had no server-side account of whether its job was ever accepted. This pins both
// halves of the fix: the ids ride the JOB BODY (so the container's own lines carry them), and the
// executor emits one line per lifecycle transition with the ids bound.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } },
  byKind: {},
}

interface Harness {
  executor: ContainerAgentExecutor
  bodies: Record<string, unknown>[]
  logger: ReturnType<typeof createRecordingLogger>
  metrics: ReturnType<typeof createOperationalMetricsCollector>
}

function makeExecutor(
  opts: { view?: RunnerJobView; dispatchError?: Error; pollError?: Error } = {},
): Harness {
  const bodies: Record<string, unknown>[] = []
  const logger = createRecordingLogger()
  const transport: RunnerTransport = {
    async dispatch(_ref, spec) {
      if (opts.dispatchError) throw opts.dispatchError
      bodies.push(spec as Record<string, unknown>)
    },
    async poll() {
      if (opts.pollError) throw opts.pollError
      return opts.view ?? { state: 'running' }
    },
  }
  const metrics = createOperationalMetricsCollector()
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      repoId: '1001',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService: {
      async mint() {
        return 'SESSION-TOKEN'
      },
    } as unknown as ContainerSessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    logger,
    operationalMetrics: metrics,
  }
  return { executor: new ContainerAgentExecutor(deps), bodies, logger, metrics }
}

function context(): AgentRunContext {
  return {
    agentKind: 'coder' as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Implement it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
  }
}

const handle: AgentJobHandle = {
  jobId: 'job_1',
  runId: 'ex_1',
  workspaceId: 'ws_1',
  agentKind: 'coder',
  model: 'workers-ai:@cf/test/model',
}

describe('container seam correlation', () => {
  it('carries the run ids on the job body so the container can bind them', async () => {
    const { executor, bodies } = makeExecutor()
    await executor.startJob(context())
    expect(bodies[0]).toMatchObject({ workspaceId: 'ws_1', executionId: 'ex_1' })
  })

  it('logs an accepted dispatch with the ids bound', async () => {
    const { executor, logger } = makeExecutor()
    await executor.startJob(context())
    const line = logger.lines.find((l) => l.msg === 'container job dispatched')
    expect(line?.level).toBe('info')
    expect(line?.fields).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'ex_1',
      jobId: 'ex_1-coder',
      agentKind: 'coder',
      model: 'workers-ai:@cf/test/model',
    })
  })

  it('names a dispatch that never happened, and still fails the step', async () => {
    // The dispatch/preflight failure class is the one where "which model, which backend" matters
    // most and where nothing downstream can report it — the job has no handle to poll.
    const { executor, logger } = makeExecutor({ dispatchError: new Error('no runner available') })
    await expect(executor.startJob(context())).rejects.toThrow('no runner available')
    const line = logger.lines.find((l) => l.msg === 'container job dispatch failed')
    expect(line?.level).toBe('warn')
    expect(line?.fields).toMatchObject({ executionId: 'ex_1', err: 'no runner available' })
  })

  it('names a poll that threw, and still surfaces the fault to the driver', async () => {
    const { executor, logger } = makeExecutor({ pollError: new Error('runner unreachable') })
    await expect(executor.pollJob(handle)).rejects.toThrow('runner unreachable')
    const line = logger.lines.find((l) => l.msg === 'container job poll failed')
    expect(line?.level).toBe('warn')
    expect(line?.fields).toMatchObject({ executionId: 'ex_1', jobId: 'job_1' })
  })

  it('keeps a still-running poll off the info stream', async () => {
    const { executor, logger } = makeExecutor({ view: { state: 'running' } })
    await executor.pollJob(handle)
    expect(logger.lines.map((l) => l.level)).toEqual(['debug'])
  })

  it('reports a settled job once, at a level matching its outcome', async () => {
    const done = makeExecutor({
      view: { state: 'done', result: { summary: 'ok' } } as RunnerJobView,
    })
    await done.executor.pollJob(handle)
    expect(done.logger.lines.find((l) => l.msg === 'container job completed')?.level).toBe('info')

    const failed = makeExecutor({
      view: {
        state: 'failed',
        error: 'container evicted',
        failureCause: 'inactivity-timeout',
      } as RunnerJobView,
    })
    await failed.executor.pollJob(handle)
    const line = failed.logger.lines.find((l) => l.msg === 'container job failed')
    expect(line?.level).toBe('warn')
    expect(line?.fields).toMatchObject({ jobId: 'job_1', failureCause: 'inactivity-timeout' })
  })

  it('COUNTS a dispatch failure, so a rising rate is visible without grepping', async () => {
    // The log line answers "why did THIS run stop"; the counter answers "is dispatch failing
    // more than it was", which no amount of reading per-run lines can.
    const { executor, metrics } = makeExecutor({ dispatchError: new Error('no runner available') })
    await expect(executor.startJob(context())).rejects.toThrow()
    const dropped = metrics.drain().find((s) => s.counter === 'container.dispatch_failed')
    expect(dropped?.value).toBe(1)
  })

  it('counts an EVICTED settle, and does not count an ordinary failed one', async () => {
    // Only a container dying under the run is an operational fault. A job that ran to
    // completion and failed (no usable output, a red validation) is the platform working, and
    // counting it here would drown the signal this counter exists for.
    const evicted = makeExecutor({
      view: { state: 'failed', evicted: 'crash', error: 'container vanished' },
    })
    await evicted.executor.pollJob(handle)
    expect(evicted.metrics.drain()).toEqual([
      { counter: 'container.evicted', dimensions: { kind: 'crash' }, value: 1 },
    ])

    const cleanFailure = makeExecutor({ view: { state: 'failed', error: 'no file changes' } })
    await cleanFailure.executor.pollJob(handle)
    expect(cleanFailure.metrics.drain()).toEqual([])
  })

  it('counts a harness SHUTDOWN, the container death that carries no eviction verdict', async () => {
    // The other way a container dies under a run, and the one nothing else counts: it is
    // mutually exclusive with `evicted` by construction, so a settle site that only reads that
    // field records this whole class as nothing at all. An operator watching the eviction rate
    // would then see it fall, as if containers had stopped dying under runs.
    const shutdown = makeExecutor({
      view: { state: 'failed', harnessShutdown: true, error: 'the harness shut down' },
    })
    await shutdown.executor.pollJob(handle)
    expect(shutdown.metrics.drain()).toEqual([
      { counter: 'container.harness_shutdown', dimensions: {}, value: 1 },
    ])
  })

  it('dimensions an eviction by its CAUSE even when the line also carries a `kind`', () => {
    // Driven through `containerJobLog` directly, because the point is what the SEAM does with
    // its log fields. The dimension used to be picked out of them as `kind ?? evicted`, which
    // was right only by accident: the settle site happened not to log a `kind`. Adding one —
    // the runner backend is an obvious thing to log beside a dead container — would have
    // silently re-pointed `container.evicted` at the backend and split the series with nothing
    // failing anywhere.
    const metrics = createOperationalMetricsCollector()
    const jobLog = containerJobLog(createRecordingLogger(), { jobId: 'job_1' }, metrics)
    jobLog.settled('failed', { evicted: 'transient', kind: 'container' })
    expect(metrics.drain()).toEqual([
      { counter: 'container.evicted', dimensions: { kind: 'transient' }, value: 1 },
    ])
  })

  it('counts a REFUSED work-branch push, the other settle the engine re-dispatches', async () => {
    // The recovery makes this invisible everywhere else: the step is re-dispatched, the run reports
    // as a clean success, and the whole agent run it cost twice shows up in no per-run signal. The
    // remedy the harness prints tells the operator to check for a second live run on the block,
    // which is a RECURRENCE, and only a rate can answer that.
    const contended = makeExecutor({
      view: { state: 'failed', failureCause: 'branch-contended', error: 'push refused' },
    })
    await contended.executor.pollJob(handle)
    expect(contended.metrics.drain()).toEqual([
      { counter: 'container.branch_contended', dimensions: {}, value: 1 },
    ])
  })

  it('dimensions a dispatch failure by the DISPATCH kind, never by a stray `evicted`', () => {
    const metrics = createOperationalMetricsCollector()
    const jobLog = containerJobLog(createRecordingLogger(), { jobId: 'job_1' }, metrics)
    jobLog.dispatchFailed(new Error('no runner'), { kind: 'container', model: 'm' })
    expect(metrics.drain()).toEqual([
      { counter: 'container.dispatch_failed', dimensions: { kind: 'container' }, value: 1 },
    ])
  })
})
