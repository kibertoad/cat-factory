import type {
  AgentRunContext,
  ModelRef,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerJobResult,
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
    resolveWebSearchEnabled: async () => true,
    // Read-only agents only probe the work branch; return true so the read-only body
    // resolves to the shared work branch (the more interesting path).
    ensureWorkBranch: async () => true,
  }
  return { executor: new ContainerAgentExecutor(deps), captured }
}

function context(
  agentKind: string,
  overrides: Partial<AgentRunContext['block']> = {},
  service?: AgentRunContext['service'],
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
    ...(service ? { service } : {}),
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

  it('on-call', async () => {
    // Escalated after merge: clones the base branch and carries the (now-historical)
    // head branch + PR number so the agent can locate the merged commit.
    await executor.startJob(context('on-call', { pullRequest: PR }))
    expect(captured[0]).toMatchSnapshot()
  })

  it('tester (local env)', async () => {
    await executor.startJob(
      context('tester', { pullRequest: PR, agentConfig: { 'tester.environment': 'local' } }),
    )
    expect(captured[0]).toMatchSnapshot()
  })

  it('tester (local, no infra) gets the no-dependencies run-mode guidance', async () => {
    // A service that declares no infra dependencies must be told nothing was stood up —
    // not the default "your infra has been stood up on localhost" line (which would send
    // the agent hunting for services that never started).
    await executor.startJob(
      context(
        'tester',
        { pullRequest: PR, agentConfig: { 'tester.environment': 'local' } },
        { noInfraDependencies: true },
      ),
    )
    const userPrompt = captured[0].spec.userPrompt as string
    expect(userPrompt).toContain('Run mode: local, no infra dependencies')
    expect(userPrompt).not.toContain('have been stood up on localhost')
    // The infra spec still flags it so the harness spins nothing up.
    expect(captured[0].spec.infra).toMatchObject({
      environment: 'local',
      noInfraDependencies: true,
    })
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

// The migrated merger/on-call dispatch the generic `agent` kind and return their JSON as
// `result.custom`; `toRunResult` maps it KIND-AWARE into `mergeAssessment`/`onCallAssessment`
// using the handle's `agentKind`. These tests pin that mapping (the poll site must supply
// `agentKind`, else the coercion silently no-ops and the merge gate sees no assessment) plus
// the conservative-on-garbage defaults that replace the harness's old `diffExaminable` guard.
function makeExecutorReturning(result: RunnerJobResult): ContainerAgentExecutor {
  const transport: RunnerTransport = {
    async dispatch() {},
    async poll() {
      return { state: 'done', result }
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
    resolveWebSearchEnabled: async () => true,
    ensureWorkBranch: async () => true,
  }
  return new ContainerAgentExecutor(deps)
}

const handle = (agentKind?: string) => ({
  jobId: 'ex_1-step',
  runId: 'ex_1',
  workspaceId: 'ws_1',
  ...(agentKind ? { agentKind } : {}),
})

describe('ContainerAgentExecutor.pollJob (kind-aware result coercion)', () => {
  it('maps a merger custom result into mergeAssessment', async () => {
    const executor = makeExecutorReturning({
      summary: 'Looks routine.',
      custom: { complexity: 0.2, risk: 0.3, impact: 0.4, rationale: 'small, isolated change' },
    })
    const update = await executor.pollJob(handle('merger'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Looks routine.',
        mergeAssessment: {
          complexity: 0.2,
          risk: 0.3,
          impact: 0.4,
          rationale: 'small, isolated change',
        },
      },
    })
  })

  it('maps an on-call custom result into onCallAssessment', async () => {
    const executor = makeExecutorReturning({
      summary: 'Likely unrelated.',
      custom: {
        culpritConfidence: 0.1,
        recommendation: 'monitor',
        rationale: 'no correlation with the diff',
        evidence: ['latency flat', 42],
      },
    })
    const update = await executor.pollJob(handle('on-call'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Likely unrelated.',
        onCallAssessment: {
          culpritConfidence: 0.1,
          recommendation: 'monitor',
          rationale: 'no correlation with the diff',
          evidence: ['latency flat'],
        },
      },
    })
  })

  it('garbage/null merger scores default to 1 (severe → human review), not 0', async () => {
    const executor = makeExecutorReturning({
      summary: 'fallback summary',
      // null / empty-string / boolean must NOT coerce to a finite 0.
      custom: { complexity: null, risk: '', impact: false, rationale: '' },
    })
    const update = await executor.pollJob(handle('merger'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'fallback summary',
        mergeAssessment: { complexity: 1, risk: 1, impact: 1, rationale: 'fallback summary' },
      },
    })
  })

  it('maps a tester custom result into a coerced testReport (greenlight withheld on a blocker)', async () => {
    const executor = makeExecutorReturning({
      summary: 'Ran the suite.',
      custom: {
        // greenlight:true with an open high-severity concern must NOT auto-pass.
        greenlight: true,
        summary: 'Two flows broke.',
        tested: ['login', 42],
        outcomes: [
          { name: 'login', status: 'failed', detail: '500 on submit' },
          { name: 'mystery', status: 'banana' },
        ],
        concerns: [{ title: 'Login 500', detail: 'crashes', severity: 'high' }],
        environment: 'local',
      },
    })
    const update = await executor.pollJob(handle('tester'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Ran the suite.',
        testReport: {
          greenlight: false,
          summary: 'Two flows broke.',
          tested: ['login'],
          outcomes: [
            { name: 'login', status: 'failed', detail: '500 on submit' },
            { name: 'mystery', status: 'skipped' },
          ],
          concerns: [{ title: 'Login 500', detail: 'crashes', severity: 'high' }],
          environment: 'local',
        },
      },
    })
  })

  it('garbage tester JSON coerces to a safe, no-greenlight report', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { junk: true } })
    const update = await executor.pollJob(handle('tester'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'nothing usable',
        testReport: {
          greenlight: false,
          summary: 'nothing usable',
          tested: [],
          outcomes: [],
          concerns: [],
        },
      },
    })
  })

  it('maps a blueprints custom result into a coerced blueprintService', async () => {
    const executor = makeExecutorReturning({
      summary: 'Mapped the service.',
      custom: {
        name: 'Widgets',
        summary: 'A widget service',
        // `references` malformed (number dropped), an unknown type falls back to 'service'.
        type: 'banana',
        references: ['src/index.ts', 7],
        modules: [{ name: 'Billing', summary: 'Invoices', references: [] }],
      },
    })
    const update = await executor.pollJob(handle('blueprints'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Mapped the service.',
        blueprintService: {
          type: 'service',
          name: 'Widgets',
          summary: 'A widget service',
          references: ['src/index.ts'],
          modules: [{ name: 'Billing', summary: 'Invoices', references: [] }],
        },
      },
    })
  })

  it('a nameless blueprints tree coerces away (no blueprintService), leaving plain output', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { modules: [] } })
    const update = await executor.pollJob(handle('blueprints'))
    expect(update).toEqual({ state: 'done', result: { output: 'nothing usable' } })
  })

  it('maps a spec-writer custom result into a coerced spec doc', async () => {
    const executor = makeExecutorReturning({
      summary: 'Wrote the spec.',
      custom: {
        service: 'Widgets',
        summary: 'A widget service',
        modules: [
          {
            name: 'Auth',
            summary: 'Authentication',
            groups: [
              {
                name: 'Login',
                summary: 'Signing in',
                requirements: [
                  {
                    id: 'req-login',
                    title: 'Password login',
                    statement: 'The system SHALL authenticate by password.',
                    kind: 'functional',
                    priority: 'must',
                    sourceBlockIds: [],
                    acceptance: [
                      {
                        id: 'ac-1',
                        given: 'a user',
                        when: 'they sign in',
                        outcome: 'a session opens',
                      },
                    ],
                  },
                ],
                rules: [],
              },
            ],
          },
        ],
      },
    })
    const update = await executor.pollJob(handle('spec-writer'))
    expect(update.state).toBe('done')
    // The custom doc is coerced into the `spec` channel the engine strict-validates +
    // the specPostOp shards/commits from (no raw `custom` left behind).
    const result = update.state === 'done' ? update.result : undefined
    expect(result?.output).toBe('Wrote the spec.')
    expect(result && 'custom' in result).toBe(false)
    expect(result?.spec).toMatchObject({
      service: 'Widgets',
      modules: [{ name: 'Auth', groups: [{ name: 'Login' }] }],
    })
  })

  it('a nameless spec-writer doc coerces away (no spec), leaving plain output', async () => {
    const executor = makeExecutorReturning({ summary: 'nothing usable', custom: { modules: [] } })
    const update = await executor.pollJob(handle('spec-writer'))
    expect(update).toEqual({ state: 'done', result: { output: 'nothing usable' } })
  })

  it('surfaces the PR for a coding result that reports BOTH pushed and prUrl', async () => {
    // The generic coding flow returns `pushed:true` AND `prUrl` (the coder). `prUrl` must
    // win over the in-place-fixer `pushed` branch, else the structured PR is silently lost.
    const executor = makeExecutorReturning({
      summary: 'Implemented the widget.',
      pushed: true,
      prUrl: 'https://github.com/acme/widgets/pull/9',
      branch: 'cat-factory/blk_1',
    })
    const update = await executor.pollJob(handle('coder'))
    expect(update).toEqual({
      state: 'done',
      result: {
        output: 'Implemented the widget.\n\nPR: https://github.com/acme/widgets/pull/9',
        pullRequest: {
          url: 'https://github.com/acme/widgets/pull/9',
          number: 9,
          branch: 'cat-factory/blk_1',
        },
      },
    })
  })

  it('maps an in-place fixer result (pushed, no prUrl) to a plain pushed output', async () => {
    const executor = makeExecutorReturning({ summary: 'Fixed the failing build.', pushed: true })
    const update = await executor.pollJob(handle('ci-fixer'))
    expect(update).toEqual({
      state: 'done',
      result: { output: 'Fixed the failing build.' },
    })
  })

  it('without agentKind the coercion no-ops and the raw custom is surfaced', async () => {
    const executor = makeExecutorReturning({
      summary: 's',
      custom: { complexity: 0.2, risk: 0.3, impact: 0.4 },
    })
    const update = await executor.pollJob(handle())
    expect(update).toEqual({
      state: 'done',
      result: { output: 's', custom: { complexity: 0.2, risk: 0.3, impact: 0.4 } },
    })
  })
})
