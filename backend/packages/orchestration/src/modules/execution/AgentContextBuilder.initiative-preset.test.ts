import { afterEach, describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, Initiative, PipelineStep } from '@cat-factory/kernel'
import { clearRegisteredInitiativePresets, registerInitiativePreset } from '@cat-factory/kernel'
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
    initiatives: { getByBlock: async () => initiative } as never,
  }
  return new AgentContextBuilder(deps as AgentContextBuilderDeps)
}

function initiativeEntity(): Initiative {
  return { id: 'i1', blockId: INIT_BLOCK.id, presetId: PRESET_ID } as unknown as Initiative
}

afterEach(() => clearRegisteredInitiativePresets())

function register(
  over: { phaseTemplate?: InitiativePresetPhaseTemplate; planner?: string } = {},
): void {
  registerInitiativePreset({
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
