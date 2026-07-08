import { beforeEach, describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, Initiative, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry } from '@cat-factory/agents'

// The builder resolves a preset's planning steering onto `context.initiative.preset` (slice T1):
// the declarative `phaseTemplate` is surfaced for the planning kinds, and — like the promptAddition
// path — a preset that contributes neither leaves the context byte-for-byte the generic shape.

const TEMPLATE: InitiativePresetPhaseTemplate = {
  phases: [
    {
      id: 'migration-blast-zone',
      title: 'Blast zone',
      goal: 'Enumerate touchpoints.',
      required: true,
    },
    { id: 'migration-coverage', title: 'Coverage hardening', goal: '', required: true },
  ],
  allowAdditionalPhases: false,
}

const PRESET_ID = 'preset_test_migration'

const INIT_BLOCK = {
  id: 'init_1',
  title: 'MSSQL → PostgreSQL',
  type: 'service',
  description: 'Swap the DB engine.',
  level: 'initiative',
  parentId: 'frame_1',
} as unknown as Block

const FRAME = {
  id: 'frame_1',
  title: 'Payments',
  type: 'service',
  description: '',
  level: 'frame',
  parentId: null,
} as unknown as Block

function step(agentKind: string): PipelineStep {
  return { agentKind, state: 'running', progress: 0 } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: INIT_BLOCK.id,
    pipelineName: 'Initiative planning',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

// A fresh app-owned registry per test (reset in `beforeEach`), injected into every builder — the
// DI replacement for the old module-global register/clear.
let presetRegistry = new InitiativePresetRegistry()
beforeEach(() => {
  presetRegistry = new InitiativePresetRegistry()
})

function makeBuilder(initiative: Initiative | null): AgentContextBuilder {
  const blocks = new Map<string, Block>([
    [FRAME.id, FRAME],
    [INIT_BLOCK.id, INIT_BLOCK],
  ])
  const deps: Partial<AgentContextBuilderDeps> = {
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: presetRegistry,
    initiatives: { getByBlock: async () => initiative } as never,
  }
  return new AgentContextBuilder(deps as AgentContextBuilderDeps)
}

function initiativeEntity(): Initiative {
  return { id: 'i1', blockId: INIT_BLOCK.id, presetId: PRESET_ID } as unknown as Initiative
}

function register(
  over: { phaseTemplate?: InitiativePresetPhaseTemplate; planner?: string } = {},
): void {
  presetRegistry.register({
    descriptor: {
      id: PRESET_ID,
      presentation: { label: 'Migration', icon: 'i', color: '#000', description: 'x' },
      fields: [],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
      defaultFragmentIds: [],
      ...(over.phaseTemplate ? { phaseTemplate: over.phaseTemplate } : {}),
    },
    ...(over.planner ? { promptAdditions: { 'initiative-planner': over.planner } } : {}),
  })
}

describe('AgentContextBuilder initiative preset context', () => {
  it('surfaces the phaseTemplate onto the planner context', async () => {
    register({ phaseTemplate: TEMPLATE })
    const s = step('initiative-planner')
    const context = await makeBuilder(initiativeEntity()).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      INIT_BLOCK,
    )
    expect(context.initiative?.preset?.label).toBe('Migration')
    expect(context.initiative?.preset?.phaseTemplate?.phases.map((p) => p.id)).toEqual([
      'migration-blast-zone',
      'migration-coverage',
    ])
    // No planner promptAddition registered ⇒ that half stays absent.
    expect(context.initiative?.preset?.promptAddition).toBeUndefined()
  })

  it('carries both the phaseTemplate and the promptAddition when both are registered', async () => {
    register({ phaseTemplate: TEMPLATE, planner: 'Chase transitive callers.' })
    const s = step('initiative-planner')
    const context = await makeBuilder(initiativeEntity()).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      INIT_BLOCK,
    )
    expect(context.initiative?.preset?.promptAddition).toBe('Chase transitive callers.')
    expect(context.initiative?.preset?.phaseTemplate).toBeDefined()
  })

  it('leaves preset undefined when the preset contributes neither steering nor a template', async () => {
    register({})
    const s = step('initiative-planner')
    const context = await makeBuilder(initiativeEntity()).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      INIT_BLOCK,
    )
    expect(context.initiative).toBeDefined()
    expect(context.initiative?.preset).toBeUndefined()
  })
})

// D1 (slice 1): a run SPAWNED by an initiative (a task carrying `block.initiativeId`) carries a
// PRESET-ONLY context — the preset's per-kind `promptAddition` for the RUNNING kind — so the org's
// standing methodology reaches the child coder / tester. No goal/qa/analysis is folded, the
// phaseTemplate never travels (planner-only), and the read is gated on `block.initiativeId` so a
// plain task pays nothing.

const SPAWNED_TASK = {
  id: 'task_1',
  title: 'Implement the connector',
  type: 'service',
  description: 'Build the connector.',
  level: 'task',
  parentId: FRAME.id,
  initiativeId: INIT_BLOCK.id,
} as unknown as Block

function spawnedInstance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_2',
    blockId: SPAWNED_TASK.id,
    pipelineName: 'pl_full',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

/** A builder whose `initiatives.getByBlock` is counted, so gating (zero reads off-initiative) is testable. */
function makeSpawnedBuilder(initiative: Initiative | null): {
  builder: AgentContextBuilder
  calls: () => number
} {
  const blocks = new Map<string, Block>([
    [FRAME.id, FRAME],
    [INIT_BLOCK.id, INIT_BLOCK],
    [SPAWNED_TASK.id, SPAWNED_TASK],
  ])
  let count = 0
  const deps: Partial<AgentContextBuilderDeps> = {
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async (_ws: string, id: string) => blocks.get(id) ?? null } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: presetRegistry,
    initiatives: {
      getByBlock: async () => {
        count++
        return initiative
      },
    } as never,
  }
  return { builder: new AgentContextBuilder(deps as AgentContextBuilderDeps), calls: () => count }
}

function registerCoder(addition: string): void {
  presetRegistry.register({
    descriptor: {
      id: PRESET_ID,
      presentation: { label: 'Migration', icon: 'i', color: '#000', description: 'x' },
      fields: [],
      planningPipelineId: 'pl_initiative',
      interview: 'full',
      humanReviewDefault: true,
      defaultFragmentIds: [],
      phaseTemplate: TEMPLATE,
    },
    promptAdditions: { coder: addition, 'initiative-planner': 'planner steering' },
  })
}

/** An initiative entity that ALSO carries goal/qa/analysis — none of which must reach a spawned run. */
function richInitiativeEntity(): Initiative {
  return {
    id: 'i1',
    blockId: INIT_BLOCK.id,
    presetId: PRESET_ID,
    goal: 'Migrate everything',
    qa: [{ question: 'Q', answer: 'A' }],
    analysisSummary: 'analysis',
  } as unknown as Initiative
}

describe('AgentContextBuilder spawned-run preset context', () => {
  it('folds the per-kind promptAddition onto a spawned coder, and NOTHING else', async () => {
    registerCoder('Follow the org connector layout.')
    const s = step('coder')
    const context = await makeSpawnedBuilder(richInitiativeEntity()).builder.buildContext(
      'ws1',
      spawnedInstance([s]),
      s,
      false,
      SPAWNED_TASK,
    )
    expect(context.initiative?.preset?.label).toBe('Migration')
    expect(context.initiative?.preset?.promptAddition).toBe('Follow the org connector layout.')
    // Preset-ONLY: the planner-only phaseTemplate and every planning field are withheld.
    expect(context.initiative?.preset?.phaseTemplate).toBeUndefined()
    expect(context.initiative?.goal).toBeUndefined()
    expect(context.initiative?.qa).toBeUndefined()
    expect(context.initiative?.analysisSummary).toBeUndefined()
  })

  it('resolves the addition for the RUNNING kind (a kind with no addition ⇒ no preset)', async () => {
    // Only `coder` and `initiative-planner` additions are registered; a spawned tester gets none.
    registerCoder('coder steering')
    const s = step('tester-api')
    const context = await makeSpawnedBuilder(richInitiativeEntity()).builder.buildContext(
      'ws1',
      spawnedInstance([s]),
      s,
      false,
      SPAWNED_TASK,
    )
    expect(context.initiative).toBeUndefined()
  })

  it('reads the initiative only when the block carries an initiativeId (gating)', async () => {
    registerCoder('coder steering')
    const plain = { ...SPAWNED_TASK, initiativeId: undefined } as unknown as Block
    const { builder, calls } = makeSpawnedBuilder(richInitiativeEntity())
    const s = step('coder')
    const context = await builder.buildContext('ws1', spawnedInstance([s]), s, false, plain)
    expect(context.initiative).toBeUndefined()
    // Zero initiative reads for a non-initiative task — the non-initiative hot path is untouched.
    expect(calls()).toBe(0)
  })

  it('leaves the context clean when the initiative entity is gone', async () => {
    registerCoder('coder steering')
    const s = step('coder')
    const context = await makeSpawnedBuilder(null).builder.buildContext(
      'ws1',
      spawnedInstance([s]),
      s,
      false,
      SPAWNED_TASK,
    )
    expect(context.initiative).toBeUndefined()
  })
})
