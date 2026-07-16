import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// `buildContext` used to re-walk frame → module → task once per service-frame resolver
// (environment / service config / frontend / fragments), and awaited every resolver in
// turn. It now walks the ancestry ONCE, threads the resolved frame into each resolver, and
// fans the mutually-independent resolutions out in a single wave. These tests pin both:
// the block-read count is the walk length (reuse-not-cache), and previously-sequential
// resolvers now overlap.

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'running', progress: 0, ...over } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineName: 'Build',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

const FRAME = {
  id: 'frame_1',
  title: 'Auth service',
  type: 'service',
  description: '',
  level: 'frame',
  parentId: null,
  cloudProvider: 'aws',
  serviceFragmentIds: ['node.best-practices'],
} as unknown as Block

const MODULE = {
  id: 'module_1',
  title: 'Sessions',
  type: 'service',
  description: '',
  level: 'module',
  parentId: 'frame_1',
} as unknown as Block

const TASK = {
  id: 'task_1',
  title: 'Login',
  type: 'service',
  description: 'do the thing',
  level: 'task',
  parentId: 'module_1',
} as unknown as Block

function makeDeps(over: Partial<AgentContextBuilderDeps> = {}): {
  deps: AgentContextBuilderDeps
  blockGets: () => number
} {
  const blocks = new Map<string, Block>([
    [FRAME.id, FRAME],
    [MODULE.id, MODULE],
    [TASK.id, TASK],
  ])
  let blockGets = 0
  const deps: AgentContextBuilderDeps = {
    workspaceRepository: { get: async () => null } as never,
    blockRepository: {
      get: async (_ws: string, id: string) => {
        blockGets++
        return blocks.get(id) ?? null
      },
      listByWorkspace: async () => [...blocks.values()],
    } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    fragmentResolver: {
      resolveBodiesForRun: async (_ws: string, ids: string[]) =>
        ids.map((id) => ({ id, body: 'BODY' })),
    },
    ...over,
  }
  return { deps, blockGets: () => blockGets }
}

describe('AgentContextBuilder ancestry-walk reuse', () => {
  it('walks frame → module → task ONCE for the whole context (not once per resolver)', async () => {
    // A code-aware kind on a task two levels below its frame: environment + service config +
    // frontend + fragments each need the frame. The old path re-walked per resolver (~8+
    // block reads); now the frame is resolved once — task in hand, so only module + frame are
    // fetched (2 reads), and no resolver re-walks.
    const { deps, blockGets } = makeDeps()
    const s = step({ agentKind: 'coder' })
    const context = await new AgentContextBuilder(deps).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )
    expect(blockGets()).toBe(2)
    // The frame's service fragments still reach a code-aware kind (proves the threaded frame
    // carries `serviceFragmentIds`, not just its id).
    expect(context.block.resolvedFragments).toEqual([{ id: 'node.best-practices', body: 'BODY' }])
    // The service config resolved off the same frame (its cloud provider).
    expect(context.service?.cloudProvider).toBe('aws')
  })

  it('reads the frame a single time even for a frame-level block (no walk, no reads)', async () => {
    const { deps, blockGets } = makeDeps()
    const s = step({ agentKind: 'coder' })
    const context = await new AgentContextBuilder(deps).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      FRAME,
    )
    // The frame is the block in hand — no ancestry read at all.
    expect(blockGets()).toBe(0)
    expect(context.service?.cloudProvider).toBe('aws')
  })

  it('overlaps previously-sequential resolvers in one wave', async () => {
    // Instrument two resolvers that live in the wave and used to run one-after-another — the
    // env resolution and the tester-secret resolution. If the wave is real they are in flight
    // together; a serial chain would never show both in flight at once.
    let inFlight = 0
    let maxInFlight = 0
    // Increment on entry (synchronous, before the internal await yields) and decrement only
    // after yielding — so if both resolvers are kicked off in the same wave, both increments
    // land before either decrement and `maxInFlight` reaches 2; a serial chain never exceeds 1.
    const tracked =
      <T>(value: T) =>
      async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve()
        await Promise.resolve()
        inFlight--
        return value
      }
    const { deps } = makeDeps({
      environmentProvisioning: {
        resolveForBlock: tracked(null),
        listHandles: async () => [],
      } as never,
      resolveTestSecretRefs: tracked([]),
    })
    const s = step({ agentKind: 'tester-api' })
    await new AgentContextBuilder(deps).buildContext('ws1', instance([s]), s, true, TASK)
    expect(maxInFlight).toBe(2)
  })
})
