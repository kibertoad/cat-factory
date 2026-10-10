import { describe, expect, it } from 'vitest'
import type {
  AgentPromptRepository,
  Block,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { createRecordingLogger, InitiativePresetRegistry } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import {
  type AgentKindVariantDefinition,
  defaultAgentKindRegistry,
  shippedBasePromptFor,
} from '@cat-factory/agents'

// A workspace's edited system prompt for an agent kind is resolved ONCE per dispatch, here in
// the engine, and folded onto the context every executor reads. These pin the three states the
// executors must be able to tell apart: an active override, a deliberate revert (a head whose
// `text` is null — which must fall back to the SHIPPED prompt, never to an empty one), and an
// unwired store (the feature simply off).

function step(agentKind = 'coder', agentVariantId?: string): PipelineStep {
  return {
    agentKind,
    state: 'running',
    progress: 0,
    ...(agentVariantId ? { stepOptions: { agentVariantId } } : {}),
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

describe('AgentContextBuilder agent-kind variant', () => {
  const TDD: AgentKindVariantDefinition = {
    id: 'org:tdd',
    baseKind: 'coder',
    promptAddition: 'Work test-first.',
  }

  /** A registry carrying the variant, as the facade injects it. */
  function registryWith(variant: AgentKindVariantDefinition) {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant(variant)
    return registry
  }

  /**
   * Dispatch a step selecting `variant.id`, with an optional workspace override. Returns the STEP
   * beside the context, because half of what a dispatch decides about a variant is recorded there
   * (`promptVariant`) rather than in the prompt it sends.
   */
  async function dispatchVariant(
    variant: AgentKindVariantDefinition,
    override?: string,
    deps: Partial<AgentContextBuilderDeps> = {},
  ) {
    const s = step('coder', variant.id)
    const context = await makeBuilder({
      agentKindRegistry: registryWith(variant),
      ...(override ? { agentPrompts: promptsRepo({ agentKind: 'coder', text: override }) } : {}),
      ...deps,
    }).buildContext('ws1', instance([s]), s, true, TASK)
    return { context, step: s }
  }

  /** Just the context, for the cases that only care about the prompt that went out. */
  async function contextForVariant(
    variant: AgentKindVariantDefinition,
    override?: string,
    deps: Partial<AgentContextBuilderDeps> = {},
  ) {
    return (await dispatchVariant(variant, override, deps)).context
  }

  it('folds an ADDITION onto the shipped prompt for the step kind', async () => {
    const registry = registryWith(TDD)
    const context = await contextForVariant(TDD)
    expect(context.systemPromptOverride).toBe(
      `${shippedBasePromptFor('coder', registry)}\n\nWork test-first.`,
    )
  })

  it('folds an ADDITION onto the WORKSPACE override when the workspace edited the kind', async () => {
    const context = await contextForVariant(TDD, 'Ship small changes.')
    expect(context.systemPromptOverride).toBe('Ship small changes.\n\nWork test-first.')
  })

  it('lets the workspace override win over a variant REPLACEMENT — the narrower tier', async () => {
    const replacing = { id: 'org:poet', baseKind: 'coder', systemPrompt: 'Be a poet.' }
    expect((await contextForVariant(replacing)).systemPromptOverride).toBe('Be a poet.')
    expect((await contextForVariant(replacing, 'Mine.')).systemPromptOverride).toBe('Mine.')
  })

  it('does NOT apply the step variant to a HELPER dispatched off that step', async () => {
    // A gate's fixer / the fork proposer is a different agent; inheriting the step's alternate
    // prompt would tell it to be something it is not.
    const s = step('coder', TDD.id)
    const context = await makeBuilder({ agentKindRegistry: registryWith(TDD) }).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
      { agentKind: 'fork-proposer' },
    )
    expect(context.systemPromptOverride).toBeUndefined()
  })

  it('runs the shipped prompt, loudly, when the variant is no longer registered', async () => {
    const logger = createRecordingLogger()
    const s = step('coder', 'org:withdrawn')
    const context = await makeBuilder({ logger }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.systemPromptOverride).toBeUndefined()
    expect(
      logger.lines
        .filter((l) => l.level === 'warn')
        .map((l) => l.msg)
        .join(' '),
    ).toMatch(/not registered/)
    // …and the step says the variant did not run, rather than leaving a reader to infer it from
    // the selection alone.
    expect(s.promptVariant).toEqual({ id: 'org:withdrawn', applied: 'withdrawn' })
  })
})

// `stepOptions.agentVariantId` is what the pipeline ASKED for; `step.promptVariant` is what the
// dispatch DID with it. They diverge whenever the workspace has edited the same kind, and every
// later reader — the run panels, Kaizen's combo key — reads the pin, so these pin down that it
// tells the truth about each disposition rather than echoing the request.
describe('AgentContextBuilder agent-kind variant pin', () => {
  const TDD: AgentKindVariantDefinition = {
    id: 'org:tdd',
    baseKind: 'coder',
    promptAddition: 'Work test-first.',
  }
  const POET: AgentKindVariantDefinition = {
    id: 'org:poet',
    baseKind: 'coder',
    systemPrompt: 'Be a poet.',
  }

  function registryWith(variant: AgentKindVariantDefinition) {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant(variant)
    return registry
  }

  async function dispatch(
    variant: AgentKindVariantDefinition,
    override?: string,
    logger = createRecordingLogger(),
  ) {
    const s = step('coder', variant.id)
    await makeBuilder({
      agentKindRegistry: registryWith(variant),
      logger,
      ...(override ? { agentPrompts: promptsRepo({ agentKind: 'coder', text: override }) } : {}),
    }).buildContext('ws1', instance([s]), s, true, TASK)
    return { step: s, warnings: logger.lines.filter((l) => l.level === 'warn') }
  }

  it('pins a fully-applied variant with a fingerprint of what it contributed', async () => {
    const { step: s, warnings } = await dispatch(TDD)
    expect(s.promptVariant?.applied).toBe('full')
    expect(s.promptVariant?.fingerprint).toBeTruthy()
    expect(warnings).toEqual([])
  })

  it('pins a REPLACEMENT the workspace displaced as superseded, and warns', async () => {
    // The silent-loss case: the workspace legitimately wins, but a deployment configured this
    // prompt in code and nothing else about the run would say it never ran.
    const { step: s, warnings } = await dispatch(POET, 'Mine.')
    expect(s.promptVariant).toEqual({ id: 'org:poet', applied: 'superseded' })
    expect(warnings.map((l) => l.msg).join(' ')).toMatch(/displaced/)
  })

  it('pins a displaced replacement whose addition survived as addition-only', async () => {
    const { step: s, warnings } = await dispatch(
      { ...POET, promptAddition: 'Work test-first.' },
      'Mine.',
    )
    expect(s.promptVariant?.applied).toBe('addition-only')
    expect(s.promptVariant?.fingerprint).toBeTruthy()
    expect(warnings).toHaveLength(1)
  })

  it('pins nothing on an unvaried step, so the stock product records nothing new', async () => {
    const s = step('coder')
    await makeBuilder({}).buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.promptVariant).toBeUndefined()
  })

  it('clears a stale pin on re-dispatch after the selection was cleared', async () => {
    // Same rule as `promptRevision`: a re-dispatch must not keep reporting what the previous
    // attempt ran under.
    const s = step('coder')
    s.promptVariant = { id: 'org:tdd', applied: 'full', fingerprint: 'stale' }
    await makeBuilder({}).buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.promptVariant).toBeUndefined()
  })
})
