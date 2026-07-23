import type {
  AgentJobHandle,
  HarnessCallMetric,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import type { HarnessCallsRecordInput } from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The executor half of live call telemetry: the harness drains its per-call rows on EVERY poll
// (drain-on-read), and they must be recorded THERE rather than only from the terminal result — a
// run whose container dies mid-flight never produces one, so batching to the end reported zero
// calls for a run that spent real tokens. The terminal write still carries the complete list for
// a transport that forwards no drain, which is why the calls' job-scoped `seq` matters: it makes
// both channels mint one row id per call.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } },
  byKind: {},
}

function call(seq: number | undefined, responseText: string): HarnessCallMetric {
  return {
    promptText: '[]',
    messageCount: 1,
    responseText,
    reasoningText: '',
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    finishReason: 'end_turn',
    ...(seq !== undefined ? { seq } : {}),
  }
}

/** An executor whose transport replays `views` one per poll, capturing every recorded batch. */
function makeExecutor(views: RunnerJobView[]): {
  executor: ContainerAgentExecutor
  batches: HarnessCallsRecordInput[]
} {
  const batches: HarnessCallsRecordInput[] = []
  let polls = 0
  const transport: RunnerTransport = {
    async dispatch() {},
    async poll() {
      return views[Math.min(polls++, views.length - 1)]!
    },
  }
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
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
    recordHarnessCalls: async (input) => {
      batches.push({ ...input, calls: [...input.calls] })
    },
  }
  return { executor: new ContainerAgentExecutor(deps), batches }
}

const handle: AgentJobHandle = {
  jobId: 'job_1',
  runId: 'ex_1',
  workspaceId: 'ws_1',
  agentKind: 'coder',
  model: 'claude:claude-opus-4-8',
  provider: 'claude',
}

describe('ContainerAgentExecutor per-call telemetry', () => {
  it('records the calls the harness drained on a RUNNING poll', async () => {
    const { executor, batches } = makeExecutor([
      { state: 'running', callMetrics: [call(0, 'first'), call(1, 'second')] },
    ])

    const update = await executor.pollJob(handle)

    expect(update.state).toBe('running')
    expect(batches).toHaveLength(1)
    expect(batches[0]!.jobId).toBe('job_1')
    expect(batches[0]!.calls.map((c) => c.responseText)).toEqual(['first', 'second'])
  })

  it('does not re-offer a live-recorded call on the terminal write', async () => {
    // The store would ignore the repeat anyway, but only after a chain-tip read + an insert per
    // call — hundreds of pointless round-trips at the end of a long run (and, on the Worker,
    // hundreds of subrequests inside one Workflow step).
    const { executor, batches } = makeExecutor([
      { state: 'running', callMetrics: [call(0, 'first'), call(1, 'second')] },
      {
        state: 'done',
        result: {
          summary: 'done',
          callMetrics: [call(0, 'first'), call(1, 'second'), call(2, 'third')],
        },
      } as RunnerJobView,
    ])

    await executor.pollJob(handle)
    await executor.pollJob(handle)

    // Batch 1: the live drain. Batch 2 (terminal, from the same poll's drain — empty here) is
    // skipped entirely, leaving only the call the drain never delivered.
    expect(batches.map((b) => b.calls.map((c) => c.responseText))).toEqual([
      ['first', 'second'],
      ['third'],
    ])
  })

  it('records the whole terminal list when the transport forwards no drain', async () => {
    // A runner pool that does not map `callMetricsPath`, or an older harness image: the terminal
    // envelope is the only channel, and nothing may be filtered out of it.
    const { executor, batches } = makeExecutor([
      {
        state: 'done',
        result: { summary: 'done', callMetrics: [call(undefined, 'a'), call(undefined, 'b')] },
      } as RunnerJobView,
    ])

    await executor.pollJob(handle)

    expect(batches.map((b) => b.calls.map((c) => c.responseText))).toEqual([['a', 'b']])
  })

  it('keeps recording after a failed batch instead of treating it as stored', async () => {
    // Recording is swallowed on failure (telemetry never fails a run), so a batch that did NOT
    // land must still be re-offered by the terminal write — a high-water mark would skip it.
    const batches: HarnessCallsRecordInput[] = []
    const views: RunnerJobView[] = [
      { state: 'running', callMetrics: [call(0, 'lost')] },
      {
        state: 'done',
        result: { summary: 'done', callMetrics: [call(0, 'lost')] },
      } as RunnerJobView,
    ]
    let polls = 0
    const executor = new ContainerAgentExecutor({
      resolveTransport: async () => ({
        async dispatch() {},
        async poll() {
          return views[Math.min(polls++, views.length - 1)]!
        },
      }),
      agentRouting: routing,
      resolveBlockModel: () => undefined,
      resolveRepoTarget: async () => ({
        installationId: 7,
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
      recordHarnessCalls: async (input) => {
        batches.push({ ...input, calls: [...input.calls] })
        if (batches.length === 1) throw new Error('telemetry store down')
      },
    })

    await executor.pollJob(handle)
    await executor.pollJob(handle)

    expect(batches.map((b) => b.calls.map((c) => c.responseText))).toEqual([['lost'], ['lost']])
  })
})
