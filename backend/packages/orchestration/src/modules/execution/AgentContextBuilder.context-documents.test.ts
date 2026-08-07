import { describe, expect, it } from 'vitest'
import type {
  Block,
  DocumentFreshness,
  DocumentRecord,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// WHICH REVISION did this run build against? (Figma initiative, Track C slice 3.)
//
// The dispatch-time refresh computes the verdict and renders it into the agent's context, where it
// does its job and vanishes with the container. Nothing persisted it, so once the run was over the
// question could only be answered by re-probing the source — which by then answers about the
// revision it is at NOW, not the one the agent read. So each dispatch records what it resolved on
// its own step, exactly as it records the model, the skills and the tool servers.

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

const TASK = {
  id: 'task_1',
  title: 'Build the checkout screen',
  type: 'frontend',
  description: '',
  level: 'task',
  parentId: null,
} as unknown as Block

function document(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws1',
    source: 'figma',
    externalId: 'file1:1-2',
    title: 'Checkout flow',
    url: 'https://figma.com/design/file1',
    excerpt: 'Checkout',
    body: '## Checkout\n\n### Layout',
    contentHash: 'h',
    sourceVersion: 'v1',
    linkedBlockId: 'task_1',
    role: null,
    docKind: null,
    syncedAt: 0,
    deletedAt: null,
    ...over,
  }
}

function makeBuilder(
  linked: DocumentRecord[],
  freshness?: DocumentFreshness,
  over: Partial<AgentContextBuilderDeps> = {},
): AgentContextBuilder {
  return new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async () => null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    documents: {
      listByBlock: async () => linked,
      get: async () => null,
      getByUrl: async () => null,
    } as never,
    ...(freshness
      ? {
          documentRefresher: {
            refresh: async (_ws: string, records: readonly DocumentRecord[]) =>
              records.map((record) => ({ record, freshness })),
          } as never,
        }
      : {}),
    ...over,
  })
}

describe('AgentContextBuilder: the documents a dispatch read', () => {
  it('records each document with the verdict the dispatch reached about it', async () => {
    const s = step()
    await makeBuilder([document()], {
      status: 'confirmed',
      version: 'v9',
      change: 'reimported',
    }).buildContext('ws1', instance([s]), s, true, TASK)

    expect(s.contextDocuments).toEqual([
      {
        title: 'Checkout flow',
        url: 'https://figma.com/design/file1',
        origin: 'figma',
        freshness: { status: 'confirmed', version: 'v9', change: 'reimported' },
      },
    ])
  })

  it('records the document with NO verdict when the deployment wires no refresher', async () => {
    // "Nobody asked" and "asked and could not tell" are different facts, and only the second is a
    // warning about the copy. A synthesised `unconfirmed` here would put a warning on every
    // document of every deployment that simply does not run the check.
    const s = step()
    await makeBuilder([document()]).buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.contextDocuments).toEqual([
      {
        title: 'Checkout flow',
        url: 'https://figma.com/design/file1',
        origin: 'figma',
      },
    ])
  })

  it('writes nothing at all for a task that linked no document', async () => {
    // Most tasks carry none, so an empty array on every step of every run would be pure weight in
    // the stored instance, and it states nothing an absent field does not.
    const s = step()
    await makeBuilder([]).buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.contextDocuments).toBeUndefined()
  })

  it('is rewritten by the next dispatch, so it describes the tree the step actually pushed', async () => {
    const s = step()
    const first = makeBuilder([document()], {
      status: 'confirmed',
      version: 'v1',
      change: 'unchanged',
    })
    await first.buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.contextDocuments?.[0]?.freshness).toMatchObject({ version: 'v1' })

    const second = makeBuilder([document()], {
      status: 'confirmed',
      version: 'v2',
      change: 'reimported',
    })
    await second.buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.contextDocuments?.[0]?.freshness).toMatchObject({ version: 'v2' })
  })

  it('is NOT rewritten by a resolution that starts no job', async () => {
    // The same rule the validation-config flag follows: the over-budget probe and a re-attach to a
    // replayed job both build a full context without dispatching. Left ungated they would overwrite
    // the record of what the shipped job actually read.
    const s = step()
    await makeBuilder([document()], {
      status: 'confirmed',
      version: 'v1',
      change: 'unchanged',
    }).buildContext('ws1', instance([s]), s, true, TASK)

    await makeBuilder([document()], {
      status: 'confirmed',
      version: 'v2',
      change: 'reimported',
    }).buildContext('ws1', instance([s]), s, true, TASK, { recordsDispatch: false })

    expect(s.contextDocuments?.[0]?.freshness).toMatchObject({ version: 'v1' })
  })
})
