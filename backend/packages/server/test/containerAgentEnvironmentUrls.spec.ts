import type { AgentRunContext, RunnerDispatchOptions, RunnerTransport } from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The ephemeral environments a dispatch hands a job ride the dispatch OPTIONS, so a transport
// whose containers cannot reach a local address can act before it starts one (the local Docker
// backend maps such a host onto its host gateway).
//
// They are declared rather than read back out of the job body, and this pins the declaring half.
// The body is a `Record<string, unknown>` whose environment URLs sit three levels down under a
// wire shape the harness owns; the first cut of the host bridge read `spec.environmentUrl`, a path
// the engine has never emitted, so the bridge could not fire in production while tests that
// hand-wrote a spec passed. `prompts.spec.ts` pins that the declaration covers every URL the
// rendered infra spec carries; this pins that it reaches the transport at all.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } },
  byKind: {},
}

function makeExecutor(): {
  executor: ContainerAgentExecutor
  dispatched: (RunnerDispatchOptions | undefined)[]
} {
  const dispatched: (RunnerDispatchOptions | undefined)[] = []
  const transport: RunnerTransport = {
    async dispatch(_ref, _spec, _kind, options) {
      dispatched.push(options)
    },
    async poll() {
      return { state: 'running' }
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
  return { executor: new ContainerAgentExecutor(deps), dispatched }
}

const context = (over: Record<string, unknown> = {}): AgentRunContext =>
  ({
    agentKind: 'tester-api',
    pipelineName: 'Ship',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Implement it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...over,
  }) as unknown as AgentRunContext

describe('ContainerAgentExecutor environments on the dispatch options', () => {
  it('carries the run own environment and every live peer', async () => {
    const { executor, dispatched } = makeExecutor()
    await executor.startJob(
      context({
        service: { provisioning: { type: 'kubernetes' } },
        environment: { url: 'http://cf-env-pr8.127.0.0.1.nip.io' },
        involvedServices: [
          { frameId: 'f_email', title: 'Email', envUrl: 'http://email-pr8.127.0.0.1.nip.io' },
          { frameId: 'f_db', title: 'DB' },
        ],
      }),
    )
    expect([...(dispatched[0]?.environments ?? [])].map((env) => env.url).sort()).toEqual([
      'http://cf-env-pr8.127.0.0.1.nip.io',
      'http://email-pr8.127.0.0.1.nip.io',
    ])
  })

  it('carries the address proved to carry, beside the URL it belongs to', async () => {
    // The pairing is the security property: the host side of every bridge a transport builds is,
    // by construction, a host this job was handed rather than a name a provider chose.
    const { executor, dispatched } = makeExecutor()
    await executor.startJob(
      context({
        service: { provisioning: { type: 'kubernetes' } },
        environment: {
          url: 'https://pr-14.test.example.cloud',
          reachability: { state: 'reached', address: '10.4.19.22' },
        },
      }),
    )
    expect(dispatched[0]?.environments).toEqual([
      { url: 'https://pr-14.test.example.cloud', address: '10.4.19.22' },
    ])
  })

  it('omits the field entirely for a job handed no environment', async () => {
    // Absent rather than an empty array, so a transport's "does this job need anything" check is
    // the same shape as every other optional dispatch directive.
    const { executor, dispatched } = makeExecutor()
    await executor.startJob(context({ agentKind: 'coder' }))
    expect(dispatched[0]?.environments).toBeUndefined()
  })
})
