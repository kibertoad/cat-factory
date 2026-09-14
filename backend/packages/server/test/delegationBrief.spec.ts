import type {
  AgentRunContext,
  DelegatedExecutorDefinition,
  DelegationBrief,
  DelegationHandle,
  DelegationStart,
  DelegationUpdate,
  ModelRef,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerTransport,
} from '@cat-factory/kernel'
import { defaultDelegatedExecutorRegistry, noopLogger } from '@cat-factory/kernel'
import { type AgentRouting, defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'
import { buildDelegatedAgentExecutor } from '../src/agents/delegatedExecutorHost.js'
import { githubRepoOrigin } from '../src/agents/containerAgentBody.js'

// THE BRIEF IS THE PRODUCTION PROMPT.
//
// The one property this whole seam turns on: a container harness and a deployment's external
// executor must be told the SAME thing about the work. If the two compositions ever diverge, the
// standards a workspace agreed on, the service estate it was briefed with and its own prompt
// override reach one executor and not the other, with nothing failing and nothing reported.
//
// So this builds both from ONE run context and compares the shared half. What the container adds
// on top is asserted to be exactly the container-only layers (the execution-environment
// directives, the PR-description sentinel the harness lifts), because those are genuinely about
// the machine: telling an external executor to write `.cat-pr-description.md` would be an
// instruction about a file nothing there reads.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } as ModelRef },
  byKind: {},
}

const REPO = {
  installationId: 7,
  repoId: '1001',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}

/** The one kind both executors run, registered identically for both. */
function registryWithKind(surface: 'container-coding' | 'delegated') {
  const registry = defaultAgentKindRegistry()
  registry.register({
    kind: 'acme:impl',
    systemPrompt: 'You implement the change end to end.',
    traits: ['code-aware'],
    agent:
      surface === 'delegated'
        ? { surface: 'delegated', executor: 'acme:executor' }
        : { surface: 'container-coding', clone: { branch: 'work' } },
  })
  return registry
}

function context(): AgentRunContext {
  return {
    agentKind: 'acme:impl',
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 'Add widget',
      type: 'service',
      description: 'Implement the widget feature.',
      resolvedFragments: [
        { id: 'std_naming', title: 'Naming', body: 'Name things after what they do.' },
      ],
    },
    ownService: { stated: true, frameId: 'frm_1', title: 'Widgets API', description: 'The API.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
  }
}

/** The harness job body one container dispatch composed. */
async function containerBody(): Promise<Record<string, unknown>> {
  const captured: { spec: Record<string, unknown> }[] = []
  const transport: RunnerTransport = {
    async dispatch(_ref: RunnerJobRef, spec: Record<string, unknown>, _kind?: RunnerDispatchKind) {
      captured.push({ spec })
    },
    async poll() {
      return { state: 'running' }
    },
  }
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => REPO,
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService: {
      async mint() {
        return 'SESSION-TOKEN'
      },
    } as unknown as ContainerSessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    ensureWorkBranch: async () => true,
    agentKindRegistry: registryWithKind('container-coding'),
  }
  await new ContainerAgentExecutor(deps).startJob(context())
  return captured[0]!.spec
}

/** The brief one delegated dispatch composed. */
async function delegationBrief(): Promise<DelegationBrief> {
  const briefs: DelegationBrief[] = []
  const definition: DelegatedExecutorDefinition = {
    id: 'acme:executor',
    presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
    poll: { intervalMs: 1000, maxDurationMs: 60_000 },
    telemetry: 'not-reported',
    create: () => ({
      async start(brief: DelegationBrief): Promise<DelegationStart> {
        briefs.push(brief)
        return { externalId: 'run-99', url: 'https://ci.acme/99' }
      },
      async poll(_handle: DelegationHandle): Promise<DelegationUpdate> {
        return { state: 'running' }
      },
    }),
  }
  const executors = defaultDelegatedExecutorRegistry()
  executors.register(definition)
  const executor = buildDelegatedAgentExecutor({
    delegatedExecutorRegistry: executors,
    agentKindRegistry: registryWithKind('delegated'),
    resolveRepoTarget: async () => REPO,
    resolveRepoOrigin: githubRepoOrigin,
    urlSafetyPolicy: undefined,
    logger: noopLogger,
    clock: { now: () => 1_700_000_000_000 },
  })
  await executor.startJob(context())
  return briefs[0]!
}

describe('the brief and the harness job body compose the same instructions', () => {
  it('tells both executors the same ROLE, standards and service', async () => {
    const [body, brief] = await Promise.all([containerBody(), delegationBrief()])
    const containerSystemPrompt = body.systemPrompt as string
    // The container layers its own directives ON TOP of the shared composition, so the shared half
    // is a PREFIX of what the harness gets rather than equal to it.
    expect(containerSystemPrompt.startsWith(brief.systemPrompt)).toBe(true)
    // And the shared half is not a stub: it carries what a workspace actually configures.
    expect(brief.systemPrompt).toContain('You implement the change end to end.')
    expect(brief.systemPrompt).toContain('Name things after what they do.')
  })

  it('tells both executors the same TASK, byte for byte', async () => {
    const [body, brief] = await Promise.all([containerBody(), delegationBrief()])
    expect(brief.userPrompt).toBe(body.userPrompt as string)
  })

  it('adds ONLY container-specific directives to the container prompt', async () => {
    const [body, brief] = await Promise.all([containerBody(), delegationBrief()])
    const extra = (body.systemPrompt as string).slice(brief.systemPrompt.length)
    // Everything the harness adds is about the machine it runs on or the file it reads back.
    // A delegated executor owns both, so none of it belongs in its brief.
    expect(extra).toContain('.cat-pr-description.md')
    expect(extra).not.toContain('Name things after what they do.')
  })

  it('names the repo, both branches and the service the work belongs to', async () => {
    const brief = await delegationBrief()
    expect(brief.repo).toMatchObject({ owner: 'acme', name: 'widgets', provider: 'github' })
    expect(brief.branches).toEqual({ base: 'main', work: 'cat-factory/blk_1' })
    // A discriminated result, never omitted: a bare task title names no software, so an absent
    // answer reads to a model like a task whose product is obvious and it supplies one.
    expect(brief.ownService).toEqual({
      stated: true,
      frameId: 'frm_1',
      title: 'Widgets API',
      description: 'The API.',
    })
  })

  it('carries the correlation key the executor must make its run recoverable by', async () => {
    // The SAME id the container path uses as its harness job id, so one run's jobs stay distinct
    // whichever executor class they landed on.
    expect((await delegationBrief()).correlationKey).toBe('ex_1-acme:impl')
  })

  it('states the platform does not know the service, rather than omitting it', async () => {
    // The two ways of having no service mean opposite things, and only one of them may be silent.
    const executors = defaultDelegatedExecutorRegistry()
    let seen: DelegationBrief | undefined
    executors.register({
      id: 'acme:executor',
      presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
      poll: { intervalMs: 1000, maxDurationMs: 60_000 },
      telemetry: 'not-reported',
      create: () => ({
        async start(brief) {
          seen = brief
          return { externalId: 'run-1' }
        },
        async poll() {
          return { state: 'running' as const }
        },
      }),
    })
    const executor = buildDelegatedAgentExecutor({
      delegatedExecutorRegistry: executors,
      agentKindRegistry: registryWithKind('delegated'),
      resolveRepoTarget: async () => REPO,
      resolveRepoOrigin: githubRepoOrigin,
      urlSafetyPolicy: undefined,
      logger: noopLogger,
      clock: { now: () => 0 },
    })
    const { ownService: _dropped, ...withoutService } = context()
    await executor.startJob(withoutService as AgentRunContext)
    expect(seen?.ownService).toEqual({ stated: false, reason: 'not-under-a-service' })
  })
})
