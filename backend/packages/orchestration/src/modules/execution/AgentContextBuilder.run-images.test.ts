import { describe, expect, it } from 'vitest'
import type {
  BinaryArtifactRecord,
  Block,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// Which dispatches get the task's reference designs resolved for delivery into the container.
//
// The gate is the running kind's DECLARED `ui` image (the same fact the executor routes the job
// by) rather than a kind-name list: only a browser-driven kind captures views, and only a capture
// has a reference to be compared against. Every other kind must not pay the two reads.

function step(agentKind: string): PipelineStep {
  return { agentKind, state: 'running', progress: 0 } as unknown as PipelineStep
}

function instance(s: PipelineStep): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineName: 'Visual build',
    status: 'running',
    currentStep: 0,
    steps: [s],
  } as unknown as ExecutionInstance
}

const TASK = {
  id: 'task_1',
  title: 'Build the checkout screen',
  type: 'frontend',
  description: '',
  level: 'task',
  parentId: null,
  fragmentIds: [],
} as unknown as Block

function reference(view: string): BinaryArtifactRecord {
  return {
    id: 'art_1',
    workspaceId: 'ws1',
    executionId: null,
    blockId: 'task_1',
    kind: 'reference',
    view,
    contentType: 'image/png',
    byteSize: 3,
    hash: 'h',
    storage: 'memory',
    storageKey: 'ws1/art_1',
    document: null,
    createdAt: 1,
  }
}

function makeBuilder(over: Partial<AgentContextBuilderDeps> = {}): {
  builder: AgentContextBuilder
  reads: number
} {
  const counter = { reads: 0 }
  const store = {
    listByBlock: async () => {
      counter.reads += 1
      return [reference('Checkout')]
    },
    listByDocuments: async () => [],
  }
  const builder = new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async () => null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    documents: {
      listByBlock: async () => [],
      get: async () => null,
      getByUrl: async () => null,
    } as never,
    resolveBinaryArtifactStore: async () => store as never,
    ...over,
  })
  return {
    builder,
    get reads() {
      return counter.reads
    },
  }
}

describe('AgentContextBuilder: the images a dispatch is handed', () => {
  it('resolves and NAMES the task’s references for a kind that declares the ui image', async () => {
    const made = makeBuilder()
    const s = step('tester-ui')

    const context = await made.builder.buildContext('ws1', instance(s), s, true, TASK)

    expect(context.referenceScreenshots).toEqual({
      files: [{ view: 'Checkout', artifactId: 'art_1', fileName: 'Checkout.png' }],
      omitted: [],
    })
  })

  it('gives a BUILDING kind the pictures instead of a capture manifest', async () => {
    const made = makeBuilder()
    const s = step('coder')

    const context = await made.builder.buildContext('ws1', instance(s), s, true, TASK)

    // Absent, not empty: this dispatch captures nothing, which is a different fact from a task
    // with no references. It is shown the same artifacts to BUILD from instead.
    expect(context.referenceScreenshots).toBeUndefined()
    expect(context.designImages?.files.map((file) => file.view)).toEqual(['Checkout'])
  })

  it('never asks for a kind that neither captures nor builds a screen', async () => {
    const made = makeBuilder()
    const s = step('merger')

    const context = await made.builder.buildContext('ws1', instance(s), s, true, TASK)

    // The reads stay off the dispatch path of every run with no use for either half.
    expect(context.referenceScreenshots).toBeUndefined()
    expect(context.designImages).toBeUndefined()
    expect(made.reads).toBe(0)
  })

  it('leaves it absent when the deployment stores no binary artifacts', async () => {
    const made = makeBuilder({ resolveBinaryArtifactStore: undefined })
    const s = step('tester-ui')

    const context = await made.builder.buildContext('ws1', instance(s), s, true, TASK)

    // The documented fallback: the tester names its own views. Not a degradation to report.
    expect(context.referenceScreenshots).toBeUndefined()
  })
})
