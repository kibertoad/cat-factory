import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// Service-connections Phase 2: a task's `involvedServiceIds` resolve into `context.involvedServices`
// (title + connection description + the peer's live ephemeral env URL), read-time stale-filtered.
// The resolution is runtime-neutral (both facades share this builder), so these unit assertions
// cover peer-URL resolution on every runtime.

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'running', progress: 0, ...over } as unknown as PipelineStep
}

function instance(blockId: string, steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId,
    pipelineName: 'Build',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

const OWN_FRAME = {
  id: 'frame_auth',
  title: 'Auth',
  type: 'service',
  level: 'frame',
  parentId: null,
  description: '',
  serviceConnections: [{ serviceBlockId: 'frame_email', description: 'sends mail via it' }],
} as unknown as Block
const PEER_FRAME = {
  id: 'frame_email',
  title: 'Email',
  type: 'service',
  level: 'frame',
  parentId: null,
  description: '',
} as unknown as Block
const UNRELATED_FRAME = {
  id: 'frame_db',
  title: 'DB',
  type: 'service',
  level: 'frame',
  parentId: null,
  description: '',
} as unknown as Block
const TASK = {
  id: 'task_login',
  title: 'Login',
  type: 'service',
  level: 'task',
  parentId: 'frame_auth',
  description: '',
  involvedServiceIds: ['frame_email'],
} as unknown as Block

interface Handle {
  frameId: string
  url: string
  status: string
  createdAt: number
}

function makeBuilder(
  handles: Handle[],
  taskOver: Partial<Block> = {},
): {
  builder: AgentContextBuilder
  task: Block
} {
  const task = { ...TASK, ...taskOver } as Block
  const blocks = [OWN_FRAME, PEER_FRAME, UNRELATED_FRAME, task]
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const deps: Partial<AgentContextBuilderDeps> = {
    workspaceRepository: { get: async () => null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    blockRepository: {
      get: async (_ws: string, id: string) => byId.get(id) ?? null,
      listByWorkspace: async () => blocks,
    } as never,
    fragmentResolver: { resolveBodiesForRun: async () => [] } as never,
    environmentProvisioning: {
      resolveForBlock: async () => null,
      listHandles: async () => handles,
    } as never,
  }
  return { builder: new AgentContextBuilder(deps as AgentContextBuilderDeps), task }
}

describe('AgentContextBuilder involved-services resolution', () => {
  it('resolves an involved service with its connection description and live env URL', async () => {
    const { builder, task } = makeBuilder([
      { frameId: 'frame_email', url: 'https://email.env', status: 'ready', createdAt: 1 },
    ])
    const s = step()
    const context = await builder.buildContext('ws1', instance('task_login', [s]), s, true, task)
    expect(context.involvedServices).toEqual([
      {
        frameId: 'frame_email',
        title: 'Email',
        description: 'sends mail via it',
        envUrl: 'https://email.env',
      },
    ])
  })

  it('omits the env URL when the involved service has no live environment', async () => {
    const { builder, task } = makeBuilder([])
    const s = step()
    const context = await builder.buildContext('ws1', instance('task_login', [s]), s, true, task)
    expect(context.involvedServices).toEqual([
      { frameId: 'frame_email', title: 'Email', description: 'sends mail via it' },
    ])
  })

  it('stale-filters an involved id that is no longer a connection neighbour', async () => {
    // `frame_db` is a service frame but not connected to the task's own frame — inert, dropped.
    const { builder, task } = makeBuilder([], {
      involvedServiceIds: ['frame_db'],
    } as Partial<Block>)
    const s = step()
    const context = await builder.buildContext('ws1', instance('task_login', [s]), s, true, task)
    expect(context.involvedServices).toBeUndefined()
  })

  it('resolves nothing for a task with no involved services', async () => {
    const { builder, task } = makeBuilder([], { involvedServiceIds: [] } as Partial<Block>)
    const s = step()
    const context = await builder.buildContext('ws1', instance('task_login', [s]), s, true, task)
    expect(context.involvedServices).toBeUndefined()
  })
})
