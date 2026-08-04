import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep, TaskTypeFields } from '@cat-factory/kernel'
import { InitiativePresetRegistry, defaultTaskTypeRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// A custom-typed task's collected form values are the per-case brief of a REUSABLE OPERATION, and
// until this resolution they reached no prompt at all: the bag rode `block.taskTypeFields` and
// nothing rendered it. The builder resolves the labelled projection ONCE per dispatch, so the
// container, inline and consensus paths cannot disagree about what the operation was asked for.

const FRAME = {
  id: 'frame_1',
  title: 'Payments',
  type: 'service',
  description: '',
  level: 'frame',
  parentId: null,
} as unknown as Block

function task(taskType: string | undefined, taskTypeFields?: TaskTypeFields): Block {
  return {
    id: 'task_1',
    title: 'Expose orders',
    type: 'service',
    description: 'Expose the order entity.',
    level: 'task',
    parentId: FRAME.id,
    ...(taskType ? { taskType } : {}),
    ...(taskTypeFields ? { taskTypeFields } : {}),
  } as unknown as Block
}

function step(agentKind: string): PipelineStep {
  return { agentKind, state: 'running', progress: 0 } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineName: 'Introduce API',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

const DESCRIPTOR = {
  taskType: 'org:introduce-api',
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose functionality over HTTP.',
  },
  fields: [
    { key: 'entity', label: 'Entity', type: 'text' as const },
    {
      key: 'authRequirement',
      label: 'Auth requirement',
      type: 'select' as const,
      options: [{ value: 'service', label: 'Service-to-service token' }],
    },
  ],
}

async function contextFor(
  block: Block,
  opts: { registered?: boolean } = { registered: true },
): Promise<Awaited<ReturnType<AgentContextBuilder['buildContext']>>> {
  const taskTypeRegistry = defaultTaskTypeRegistry()
  if (opts.registered) taskTypeRegistry.register(DESCRIPTOR)
  const blocks = new Map<string, Block>([
    [FRAME.id, FRAME],
    [block.id, block],
  ])
  const deps: Partial<AgentContextBuilderDeps> = {
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    taskTypeRegistry,
  }
  const s = step('coder')
  return new AgentContextBuilder(deps as AgentContextBuilderDeps).buildContext(
    'ws1',
    instance([s]),
    s,
    true,
    block,
  )
}

describe('AgentContextBuilder custom task-type parameters', () => {
  it('resolves the collected values under the descriptor labels', async () => {
    const context = await contextFor(
      task('org:introduce-api', { custom: { entity: 'Order', authRequirement: 'service' } }),
    )
    expect(context.customTaskType?.label).toBe('Introduce API')
    expect(context.customTaskType?.fields).toEqual([
      { key: 'entity', label: 'Entity', value: 'Order' },
      { key: 'authRequirement', label: 'Auth requirement', value: 'Service-to-service token' },
    ])
  })

  it('keeps every value when the type is NOT registered on this node', async () => {
    // The normal state of a node whose build predates the registration: drift may cost the
    // labels, never the parameters the operation was invoked with.
    const context = await contextFor(task('org:introduce-api', { custom: { entity: 'Order' } }), {
      registered: false,
    })
    expect(context.customTaskType?.label).toBe('org:introduce-api')
    expect(context.customTaskType?.fields).toEqual([{ key: 'entity', value: 'Order' }])
  })

  it('is absent for a run that collected nothing, so the prompt is unchanged', async () => {
    expect((await contextFor(task('feature'))).customTaskType).toBeUndefined()
    // A built-in type's own top-level fields are not the custom bag and do not fold here.
    expect((await contextFor(task('bug', { severity: 'high' }))).customTaskType).toBeUndefined()
  })

  it('is absent for a BUILT-IN type carrying a custom bag', async () => {
    // `createTaskSchema.taskTypeFields` accepts the bag for any type (slice 2 owns the creation
    // check), so this row is reachable. It is NOT drift: a built-in has no descriptor however
    // current the build is, so the raw-id fallback would head the prompt section
    // `## Task parameters (feature)` over keys nothing declared, inventing an operation.
    const context = await contextFor(task('feature', { custom: { entity: 'Order' } }))
    expect(context.customTaskType).toBeUndefined()
  })

  it('still carries the bag when no registry is wired at all', async () => {
    const blocks = new Map<string, Block>([[FRAME.id, FRAME]])
    const block = task('org:introduce-api', { custom: { entity: 'Order' } })
    blocks.set(block.id, block)
    const deps: Partial<AgentContextBuilderDeps> = {
      workspaceRepository: { get: async () => null } as never,
      blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
      accountRepository: { get: async () => null } as never,
      agentKindRegistry: defaultAgentKindRegistry(),
      initiativePresetRegistry: new InitiativePresetRegistry(),
    }
    const s = step('coder')
    const context = await new AgentContextBuilder(deps as AgentContextBuilderDeps).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      block,
    )
    expect(context.customTaskType?.fields).toEqual([{ key: 'entity', value: 'Order' }])
  })
})
