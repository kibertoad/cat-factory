import type {
  AgentRunContext,
  McpServerDefinition,
  RunnerDispatchAck,
  RunnerJobRef,
  RunnerTransport,
} from '@cat-factory/kernel'
import { createOperationalMetricsCollector, createRecordingLogger } from '@cat-factory/kernel'
import { AgentKindRegistry, type AgentRouting } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The job-body capability handshake at the DISPATCH site.
//
// The failure it exists for is invisible from every other angle: an image older than a body
// capability does not reject the field, it ignores it, and the prompt this backend composed has
// already told the agent it has the tool. So the assertions here are all about which of the three
// handshake answers a dispatch acts on, and how hard. A refusal on the wrong one costs every
// deployment one image behind all of its tool-server runs, and a pass on the wrong one is the
// blind run itself.

// A claude-code harness, because it is the only one whose CLI speaks MCP over `http`. On Pi
// the dispatch would drop the server with a stated reason and the body would carry no capability
// at all, which is the "nothing promised" case rather than the one under test.
const routing: AgentRouting = {
  default: { ref: { provider: 'anthropic', model: 'claude-sonnet', harness: 'claude-code' } },
  byKind: {},
}

const TOOL_SERVER: McpServerDefinition = {
  id: 'docs',
  label: 'Docs',
  transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
}

/** A registry whose `coder` carries one tool server, so a dispatch's body carries `mcpServers`. */
function registryWithToolServer(): AgentKindRegistry {
  const registry = new AgentKindRegistry()
  registry.registerToolServer(TOOL_SERVER)
  registry.assignToolServers('coder', ['docs'])
  return registry
}

interface Harness {
  executor: ContainerAgentExecutor
  bodies: Record<string, unknown>[]
  released: RunnerJobRef[]
  logger: ReturnType<typeof createRecordingLogger>
  metrics: ReturnType<typeof createOperationalMetricsCollector>
}

function makeExecutor(opts: { ack?: RunnerDispatchAck; withToolServer?: boolean } = {}): Harness {
  const bodies: Record<string, unknown>[] = []
  const released: RunnerJobRef[] = []
  const logger = createRecordingLogger()
  const metrics = createOperationalMetricsCollector()
  const transport: RunnerTransport = {
    async dispatch(_ref, spec) {
      bodies.push(spec as Record<string, unknown>)
      return opts.ack
    },
    async poll() {
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
    githubApiBase: 'https://api.github.com',
    logger,
    operationalMetrics: metrics,
    // Ambient (native) auth, so the fixture leases no subscription token: this suite is about
    // the handshake, and the credential path has its own coverage.
    nativeAmbientAuth: () => true,
    ...(opts.withToolServer === false ? {} : { agentKindRegistry: registryWithToolServer() }),
  }
  return { executor: new ContainerAgentExecutor(deps), bodies, released, logger, metrics }
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

describe('capability handshake at dispatch', () => {
  it('refuses a run the image told us it cannot serve, and stops the job it started', async () => {
    // The harness begins work on acceptance, so a refusal that left the job running would let a
    // blind agent finish (and possibly open a PR) for a step the engine has already failed.
    const { executor, released } = makeExecutor({ ack: { capabilities: ['skills'] } })
    await expect(executor.startJob(context())).rejects.toThrow(/tool servers \(MCP\)/)
    expect(released).toEqual([{ runId: 'ex_1', jobId: 'ex_1-coder' }])
  })

  it('refuses with a machine-readable reason, so the step failure is a preflight fault', async () => {
    // A `DomainError` reason is what `classifyDispatchFailure` turns into `failureKind:
    // 'preflight'`: a configuration fault an operator fixes, not a container that died.
    const { executor } = makeExecutor({ ack: { capabilities: [] } })
    await expect(executor.startJob(context())).rejects.toMatchObject({
      details: { reason: 'runner_image_capability' },
    })
  })

  it('proceeds when the image named the capability', async () => {
    const { executor, released } = makeExecutor({ ack: { capabilities: ['mcpServers'] } })
    const handle = await executor.startJob(context())
    expect(handle.jobId).toBe('ex_1-coder')
    expect(released).toEqual([])
  })

  it('proceeds, and says so, when no handshake was reported at all', async () => {
    // The false-accusation guard. Every image between "tool servers landed" and "the handshake
    // landed" serves them perfectly and reports nothing; refusing here would take those runs out
    // on no evidence. The blind spot is REPORTED instead, on both channels.
    const { executor, logger, metrics, released } = makeExecutor({ ack: undefined })
    const handle = await executor.startJob(context())
    expect(handle.jobId).toBe('ex_1-coder')
    expect(released).toEqual([])
    const line = logger.lines.find(
      (l) => l.msg === 'container job dispatched without a capability handshake',
    )
    expect(line?.level).toBe('warn')
    expect(line?.fields).toMatchObject({ executionId: 'ex_1', capabilities: ['mcpServers'] })
    expect(metrics.drain()).toContainEqual({
      counter: 'container.capability_unknown',
      dimensions: { capability: 'mcpServers' },
      value: 1,
    })
  })

  it('counts a refusal per capability, dimensioned by the capability alone', async () => {
    // The run/workspace ids are the interesting split and are unbounded, so they stay on the log
    // line; the dimension has to be the closed vocabulary or the series explodes.
    const { executor, metrics } = makeExecutor({ ack: { capabilities: [] } })
    await expect(executor.startJob(context())).rejects.toThrow()
    expect(metrics.drain()).toContainEqual({
      counter: 'container.capability_unsupported',
      dimensions: { capability: 'mcpServers' },
      value: 1,
    })
  })

  it('says nothing at all when the body carried no capability', async () => {
    // Most dispatches are this one. A handshake-less image must not produce a warning per step
    // for a body that promised the agent nothing.
    const { executor, logger, metrics } = makeExecutor({ ack: undefined, withToolServer: false })
    await executor.startJob(context())
    expect(logger.lines.some((l) => l.msg.includes('capability'))).toBe(false)
    expect(metrics.drain()).toEqual([])
  })
})
