import { describe, expect, it } from 'vitest'
import type {
  AgentPromptRepository,
  Block,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// A workspace's edited system prompt for an agent kind is resolved ONCE per dispatch, here in
// the engine, and folded onto the context every executor reads. These pin the three states the
// executors must be able to tell apart: an active override, a deliberate revert (a head whose
// `text` is null — which must fall back to the SHIPPED prompt, never to an empty one), and an
// unwired store (the feature simply off).

function step(agentKind = 'coder'): PipelineStep {
  return { agentKind, state: 'running', progress: 0 } as unknown as PipelineStep
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
  title: 'Login',
  type: 'service',
  description: '',
  level: 'task',
  parentId: null,
} as unknown as Block

function promptsRepo(
  head: { agentKind: string; text: string | null } | null,
): AgentPromptRepository {
  return {
    listRevisions: async () => [],
    listRevisionsByKinds: async () => [],
    listHeads: async () => [],
    head: async (_ws, agentKind) =>
      head && head.agentKind === agentKind
        ? { agentKind, revision: 1, text: head.text, createdAt: 1 }
        : null,
    append: async () => undefined,
  }
}

function makeBuilder(over: Partial<AgentContextBuilderDeps> = {}): AgentContextBuilder {
  const blocks = new Map<string, Block>([[TASK.id, TASK]])
  return new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
    ...over,
  })
}

async function contextFor(deps: Partial<AgentContextBuilderDeps>, kind = 'coder') {
  const s = step(kind)
  return makeBuilder(deps).buildContext('ws1', instance([s]), s, true, TASK)
}

describe('AgentContextBuilder system-prompt override', () => {
  it('folds the workspace override for the dispatched kind onto the context', async () => {
    const context = await contextFor({
      agentPrompts: promptsRepo({ agentKind: 'coder', text: 'Ship the smallest correct change.' }),
    })
    expect(context.systemPromptOverride).toBe('Ship the smallest correct change.')
  })

  it('leaves the override absent for a kind the workspace has not edited', async () => {
    const context = await contextFor({
      agentPrompts: promptsRepo({ agentKind: 'architect', text: 'other kind' }),
    })
    expect(context.systemPromptOverride).toBeUndefined()
  })

  it('treats a reverted head (null text) as no override, not as an empty prompt', async () => {
    // The revert is recorded rather than deleted, so the head EXISTS with a null text. Reading
    // it as an override would send an empty system prompt instead of the shipped one.
    const context = await contextFor({
      agentPrompts: promptsRepo({ agentKind: 'coder', text: null }),
    })
    expect(context.systemPromptOverride).toBeUndefined()
  })

  it('resolves nothing when the override store is not wired', async () => {
    const context = await contextFor({})
    expect(context.systemPromptOverride).toBeUndefined()
  })

  it('keys off the EFFECTIVE dispatched kind, so a gate helper gets its own prompt', async () => {
    // A `ci` gate dispatches its `ci-fixer` helper off the hosting step, whose own kind is the
    // gate. The override must follow what actually RUNS, exactly as the trait-driven context does.
    const s = step('ci')
    const context = await makeBuilder({
      agentPrompts: promptsRepo({ agentKind: 'ci-fixer', text: 'Fix the build only.' }),
    }).buildContext('ws1', instance([s]), s, true, TASK, { agentKind: 'ci-fixer' })
    expect(context.systemPromptOverride).toBe('Fix the build only.')
  })
})

describe('AgentContextBuilder prompt-revision pin', () => {
  // The sibling of `step.skillVersions`: the prompt log is append-only, so "which prompt did
  // this step run under" has to be recorded AT dispatch. Kaizen reads it to key its
  // `(prompt, agent, model)` combo, which is what stops an edited prompt inheriting a
  // verification the shipped one earned.
  async function pinFor(head: { agentKind: string; text: string | null } | null) {
    const s = step()
    await makeBuilder({ agentPrompts: promptsRepo(head) }).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )
    return s.promptRevision
  }

  it('pins the live revision when the kind runs an edited prompt', async () => {
    expect(await pinFor({ agentKind: 'coder', text: 'Ship small changes.' })).toBe(1)
  })

  it('pins nothing when the kind runs the shipped prompt', async () => {
    expect(await pinFor(null)).toBeUndefined()
  })

  it('pins nothing after a deliberate revert, so it reads as "the product’s prompt"', async () => {
    // A revert's head EXISTS with a null text. Pinning its number would file the run under a
    // revision that carries no prompt — and split it off from every unedited run of the same
    // kind, which is exactly what it should now be grouped with.
    expect(await pinFor({ agentKind: 'coder', text: null })).toBeUndefined()
  })

  it('clears a stale pin when a re-dispatch finds the override gone', async () => {
    // A step re-dispatched after the workspace reverted must not keep reporting the revision
    // its previous attempt ran under.
    const s = step()
    s.promptRevision = 7
    await makeBuilder({ agentPrompts: promptsRepo(null) }).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )
    expect(s.promptRevision).toBeUndefined()
  })
})
