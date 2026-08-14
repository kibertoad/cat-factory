import type { AgentRunContext, RunnerJobRef, RunnerTransport } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The executor image a step runs on has to reach the transport TWICE: once as a dispatch option
// (which backend to start it on) and once on the job REF, which is how every later call finds
// the container again.
//
// The ref half is the one with a silent failure mode. A per-run container backend hosts a whole
// run in one container, so a `tester-ui` step gets a SECOND container; a poll or release that
// omits the variant addresses the run's ordinary container instead, which answers "no such job"
// and reads as an eviction while the browser container works on to its idle timeout. Nothing
// throws at any point.
//
// It is DERIVED from the agent kind at both sites rather than persisted on the handle, so these
// also pin that a handle carrying only the kind (which is all the poll site rebuilds from, on
// another isolate, after a durable replay) still resolves the same container.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } },
  byKind: {},
}

function makeExecutor(): {
  executor: ContainerAgentExecutor
  dispatched: { ref: RunnerJobRef; image: string | undefined }[]
  polled: RunnerJobRef[]
  released: RunnerJobRef[]
} {
  const dispatched: { ref: RunnerJobRef; image: string | undefined }[] = []
  const polled: RunnerJobRef[] = []
  const released: RunnerJobRef[] = []
  const transport: RunnerTransport = {
    async dispatch(ref, _spec, _kind, options) {
      dispatched.push({ ref, image: options?.image })
    },
    async poll(ref) {
      polled.push(ref)
      return { state: 'running' }
    },
    async release(ref) {
      released.push(ref)
    },
  }
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
    ensureWorkBranch: async () => true,
  }
  return { executor: new ContainerAgentExecutor(deps), dispatched, polled, released }
}

const context = (agentKind: string): AgentRunContext =>
  ({
    agentKind,
    pipelineName: 'Build & visual confirmation',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Implement it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
  }) as unknown as AgentRunContext

describe('ContainerAgentExecutor image variant', () => {
  it('carries the ui variant on the dispatch options AND the ref', async () => {
    const { executor, dispatched } = makeExecutor()
    await executor.startJob(context('tester-ui'))
    expect(dispatched[0]!.image).toBe('ui')
    expect(dispatched[0]!.ref.image).toBe('ui')
  })

  it('leaves the ref unqualified for a kind that declares no image', async () => {
    // The default has to stay ABSENT rather than an explicit 'default': the container key is
    // derived from it, and every existing container, label and inventory row was written under
    // the bare run id.
    const { executor, dispatched } = makeExecutor()
    await executor.startJob(context('coder'))
    expect(dispatched[0]!.image).toBeUndefined()
    expect(dispatched[0]!.ref.image).toBeUndefined()
  })

  it('re-derives the variant when polling and releasing the handle', async () => {
    const { executor, polled, released } = makeExecutor()
    const handle = await executor.startJob(context('tester-ui'))

    await executor.pollJob(handle)
    await executor.stopJob(handle)

    expect(polled[0]!.image).toBe('ui')
    expect(released[0]!.image).toBe('ui')
  })

  it('re-derives it from the kind alone, as a replayed poll does', async () => {
    // The poll site rebuilds the handle from the persisted STEP: a fresh process holds no
    // dispatch-time state, so the variant has to be a function of what the step carries.
    const { executor, polled } = makeExecutor()
    await executor.pollJob({
      jobId: 'ex_1-tester-ui',
      runId: 'ex_1',
      workspaceId: 'ws_1',
      agentKind: 'tester-ui',
    })
    expect(polled[0]!.image).toBe('ui')
  })
})
