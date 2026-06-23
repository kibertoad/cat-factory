import type {
  AgentRunContext,
  ModelRef,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// Characterization snapshot of the harness job body `buildJobBody` produces for each
// agent kind. `buildJobBody` is private, so we drive it through `startJob` and capture
// what reaches the runner transport's `dispatch(ref, spec, kind)`. The Phase-3 refactor
// (ModelRouter + a common-body + per-kind delta table) is behaviour-preserving, so these
// snapshots must be byte-identical before and after — they are the diff-the-bodies guard
// the plan calls for.

const PI_REF: ModelRef = { provider: 'workers-ai', model: '@cf/test/model' }

const routing: AgentRouting = {
  default: { ref: PI_REF },
  byKind: {},
}

interface Captured {
  ref: RunnerJobRef
  spec: Record<string, unknown>
  kind: RunnerDispatchKind
}

function makeExecutor(): { executor: ContainerAgentExecutor; captured: Captured[] } {
  const captured: Captured[] = []
  const transport: RunnerTransport = {
    async dispatch(ref, spec, kind) {
      captured.push({ ref, spec, kind })
    },
    async poll() {
      return { state: 'running' }
    },
  }
  const sessionService = {
    async mint() {
      return 'SESSION-TOKEN'
    },
  } as unknown as ContainerSessionService

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
    sessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    webSearchProxyEnabled: true,
    // Read-only agents only probe the work branch; return true so the read-only body
    // resolves to the shared work branch (the more interesting path).
    ensureWorkBranch: async () => true,
  }
  return { executor: new ContainerAgentExecutor(deps), captured }
}

function context(
  agentKind: string,
  overrides: Partial<AgentRunContext['block']> = {},
): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 'Add widget',
      type: 'feature',
      description: 'Implement the widget feature.',
      ...overrides,
    },
    priorOutputs: [],
    decisions: [],
  }
}

const PR = { url: 'https://github.com/acme/widgets/pull/9', number: 9, branch: 'cat-factory/blk_1' }

describe('ContainerAgentExecutor.buildJobBody (per-kind body shapes)', () => {
  let executor: ContainerAgentExecutor
  let captured: Captured[]

  beforeEach(() => {
    const made = makeExecutor()
    executor = made.executor
    captured = made.captured
  })

  it('blueprints', async () => {
    await executor.startJob(context('blueprints'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('spec-writer', async () => {
    await executor.startJob(context('spec-writer'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('ci-fixer', async () => {
    await executor.startJob(context('ci-fixer', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('conflict-resolver', async () => {
    await executor.startJob(context('conflict-resolver', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('merger', async () => {
    await executor.startJob(context('merger', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('tester (local env)', async () => {
    await executor.startJob(
      context('tester', { pullRequest: PR, agentConfig: { 'tester.environment': 'local' } }),
    )
    expect(captured[0]).toMatchSnapshot()
  })

  it('fixer', async () => {
    await executor.startJob(context('fixer', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('read-only (architect)', async () => {
    await executor.startJob(context('architect'))
    expect(captured[0]).toMatchSnapshot()
  })

  it('default (coder)', async () => {
    await executor.startJob(context('coder'))
    expect(captured[0]).toMatchSnapshot()
  })
})
