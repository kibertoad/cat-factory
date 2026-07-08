import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// The best-practice fragment fold is trait-driven: only a `code-aware` kind receives
// the service's selected fragments. Gate/tester steps dispatch their helpers off the
// HOSTING step (whose kind is the gate/tester, not the helper), so `buildContext`
// takes an explicit `agentKind` override — these tests pin that a code-aware helper
// (`ci-fixer`/`fixer`/`on-call`) actually receives the fragments, and that the
// recorded `step.selectedFragmentIds` clears when a later round resolves to nothing.

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'ci',
    state: 'running',
    progress: 0,
    ...over,
  } as unknown as PipelineStep
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
  serviceFragmentIds: ['node.best-practices'],
} as unknown as Block

const TASK = {
  id: 'task_1',
  title: 'Login',
  type: 'service',
  description: '',
  level: 'task',
  parentId: 'frame_1',
} as unknown as Block

function makeBuilder(over: Partial<AgentContextBuilderDeps> = {}): AgentContextBuilder {
  const blocks = new Map<string, Block>([
    [FRAME.id, FRAME],
    [TASK.id, TASK],
  ])
  return new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    fragmentResolver: {
      resolveBodiesForRun: async (_ws: string, ids: string[]) =>
        ids
          .filter((id) => id === 'node.best-practices' || id.startsWith('style.'))
          .map((id) => ({
            id,
            body: id === 'node.best-practices' ? 'STANDARD-BODY' : 'STYLE-BODY',
          })),
    },
    ...over,
  })
}

describe('AgentContextBuilder fragment resolution', () => {
  it('attaches the service fragments for a code-aware step kind', async () => {
    const s = step({ agentKind: 'coder' })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.block.resolvedFragments).toEqual([
      { id: 'node.best-practices', body: 'STANDARD-BODY' },
    ])
    expect(s.selectedFragmentIds).toEqual(['node.best-practices'])
  })

  it('attaches no fragments for a non-code-aware hosting kind (a gate step)', async () => {
    const s = step({ agentKind: 'ci' })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.block.resolvedFragments).toBeUndefined()
    expect(s.selectedFragmentIds).toBeUndefined()
  })

  it('resolves fragments for a code-aware HELPER dispatched off a gate step (agentKind override)', async () => {
    const s = step({ agentKind: 'ci' })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK, {
      agentKind: 'ci-fixer',
    })
    expect(context.agentKind).toBe('ci-fixer')
    expect(context.block.resolvedFragments).toEqual([
      { id: 'node.best-practices', body: 'STANDARD-BODY' },
    ])
    expect(s.selectedFragmentIds).toEqual(['node.best-practices'])
  })

  it('clears a stale selectedFragmentIds when a re-dispatch resolves to nothing', async () => {
    const s = step({ agentKind: 'coder', selectedFragmentIds: ['node.best-practices'] })
    const builder = makeBuilder({
      fragmentResolver: { resolveBodiesForRun: async () => [] },
    })
    const context = await builder.buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.block.resolvedFragments).toBeUndefined()
    expect(s.selectedFragmentIds).toBeUndefined()
  })

  it('folds the block style pins into a doc-aware kind (doc-outliner) without a code-aware trait', async () => {
    // A document task under a doc frame with no service fragments: the doc-aware kind still
    // gets the block's own style pins folded, proving the fold gate accepts `doc-aware`.
    const docFrame = {
      id: 'doc_frame',
      title: 'Handbook',
      type: 'document',
      description: '',
      level: 'frame',
      parentId: null,
    } as unknown as Block
    const docTask = {
      id: 'doc_task',
      title: 'Onboarding guide',
      type: 'document',
      description: '',
      level: 'task',
      parentId: 'doc_frame',
      fragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
    } as unknown as Block
    const blocks = new Map<string, Block>([
      [docFrame.id, docFrame],
      [docTask.id, docTask],
    ])
    const builder = makeBuilder({
      blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    })
    const s = step({ agentKind: 'doc-outliner' })
    const context = await builder.buildContext('ws1', instance([s]), s, true, docTask)
    expect(context.block.resolvedFragments).toEqual([
      { id: 'style.anti-llmisms', body: 'STYLE-BODY' },
      { id: 'style.concise-actionable', body: 'STYLE-BODY' },
    ])
    expect(s.selectedFragmentIds).toEqual(['style.anti-llmisms', 'style.concise-actionable'])
  })

  it('folds fragments into the doc-reviewer companion (doc-aware) so style guidance is its criteria', async () => {
    const s = step({ agentKind: 'doc-reviewer' })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.block.resolvedFragments).toEqual([
      { id: 'node.best-practices', body: 'STANDARD-BODY' },
    ])
    expect(s.selectedFragmentIds).toEqual(['node.best-practices'])
  })

  it('clears a stale selectedFragmentIds when the step is re-dispatched as a non-code-aware kind', async () => {
    // A gate/tester host step keeps its own (non-code-aware) kind; a prior code-aware
    // helper round left selectedFragmentIds behind. Re-dispatching the host must not keep
    // reporting fragments it never received — the trait early-return has to clear it too.
    const s = step({ agentKind: 'tester', selectedFragmentIds: ['node.best-practices'] })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.block.resolvedFragments).toBeUndefined()
    expect(s.selectedFragmentIds).toBeUndefined()
  })
})
