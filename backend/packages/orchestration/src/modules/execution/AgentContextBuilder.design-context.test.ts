import { describe, expect, it } from 'vitest'
import type { Block, DocumentRecord, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { DESIGN_CONTEXT_FRAGMENT_ID } from '@cat-factory/prompt-fragments'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// The design-context guidance is folded by PRESENCE, not by selection: a run whose resolved linked
// context carries a design-origin document gets it automatically.
//
// It had to be, because nothing else selected it. The `appliesTo` selector on the fragment is a
// management-surface hint the run path never drove, the fragment is in no seed pin set, and basic mode
// hides the per-task fragment picker — so the standard case (a designer links a Figma frame and starts
// a run) executed with a design context file on disk and no instruction anywhere to honour it.

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
  fragmentIds: ['node.best-practices'],
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
    // Echoes back whatever ids it is asked for, so the assertions read the SELECTION the builder made.
    fragmentResolver: {
      resolveBodiesForRun: async (_ws: string, ids: string[]) =>
        ids.map((id) => ({ id, body: `BODY:${id}` })),
    },
    ...over,
  })
}

describe('AgentContextBuilder: design-context guidance', () => {
  it('folds the design fragment when the run carries a design-origin document', async () => {
    const s = step()
    const context = await makeBuilder([document()]).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )

    expect(context.block.resolvedFragments?.map((f) => f.id)).toEqual([
      'node.best-practices',
      DESIGN_CONTEXT_FRAGMENT_ID,
    ])
    // Recorded on the step like every other selection, so "did this run read the design guidance"
    // is answerable from the run record rather than by re-deriving it.
    expect(s.selectedFragmentIds).toContain(DESIGN_CONTEXT_FRAGMENT_ID)
  })

  it('does NOT fold it for a prose document, however UI-ish the task is', async () => {
    // The trigger is the design the run actually carries, not the block's type — which is exactly
    // what the retired `appliesTo: { blockTypes: ['frontend'] }` selector got wrong in both
    // directions (a frontend task with no design, a design linked to an unlabelled task).
    const s = step()
    const context = await makeBuilder([
      document({ source: 'confluence', externalId: '42', url: 'https://wiki/42' }),
    ]).buildContext('ws1', instance([s]), s, true, TASK)

    expect(context.block.resolvedFragments?.map((f) => f.id)).toEqual(['node.best-practices'])
  })

  it('does not fold it twice when the workspace already pinned it', async () => {
    const pinned = {
      ...TASK,
      fragmentIds: ['node.best-practices', DESIGN_CONTEXT_FRAGMENT_ID],
    } as unknown as Block
    const s = step()
    const context = await makeBuilder([document()]).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      pinned,
    )

    expect(context.block.resolvedFragments?.map((f) => f.id)).toEqual([
      'node.best-practices',
      DESIGN_CONTEXT_FRAGMENT_ID,
    ])
  })

  it('folds it for a task that pinned nothing at all', async () => {
    // The common designer case: nobody has touched the fragment picker (basic mode does not show it),
    // so an empty selection is exactly the state the presence rule has to serve.
    const bare = { ...TASK, fragmentIds: undefined } as unknown as Block
    const s = step()
    const context = await makeBuilder([document()]).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      bare,
    )

    expect(context.block.resolvedFragments?.map((f) => f.id)).toEqual([DESIGN_CONTEXT_FRAGMENT_ID])
  })

  it('resolves the fragments WITHOUT waiting on the freshness refresh', async () => {
    // The flag needs the document ORIGINS, which are known the moment the corpus read returns. The
    // refresh that follows is a live probe per source plus a possible whole-file re-download, and
    // nothing it can answer changes an origin, so binding the flag to the finished context would
    // serialise the fragment fold (an LLM call, when a standard needs condensing) behind a Figma
    // round trip on every dispatch, turning two parallel wave entries into their sum.
    let releaseRefresh = () => {}
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let reachedFragments = () => {}
    const fragmentsReached = new Promise<void>((resolve) => {
      reachedFragments = resolve
    })
    const s = step()
    const built = makeBuilder([document()], {
      documentRefresher: {
        refresh: async (_ws, records) => {
          await refreshBlocked
          return records.map((record) => ({ record, freshness: { status: 'not-applicable' } }))
        },
      },
      fragmentResolver: {
        resolveBodiesForRun: async (_ws: string, ids: string[]) => {
          reachedFragments()
          return ids.map((id) => ({ id, body: `BODY:${id}` }))
        },
      },
    }).buildContext('ws1', instance([s]), s, true, TASK)

    // The assertion IS this await: the refresh is parked and never released until below, so if the
    // design flag waits on the finished linked context, the fragment fold is never reached and this
    // hangs to the test timeout. Reaching it proves the two wave entries are a pair, not a chain.
    await fragmentsReached

    releaseRefresh()
    const context = await built
    expect(context.block.resolvedFragments?.map((f) => f.id)).toEqual([
      'node.best-practices',
      DESIGN_CONTEXT_FRAGMENT_ID,
    ])
  })

  it('stays out of a kind that receives no standards at all', async () => {
    // A gate host is neither code-aware nor doc-aware, so it folds nothing — a design document must
    // not become the one thing that starts charging it for standards.
    const s = step({ agentKind: 'ci' })
    const context = await makeBuilder([document()]).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )

    expect(context.block.resolvedFragments).toBeUndefined()
  })
})
