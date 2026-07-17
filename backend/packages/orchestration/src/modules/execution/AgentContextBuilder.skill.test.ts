import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry, ValidationError } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry, SKILL_AGENT_KIND } from '@cat-factory/agents'

// The `skill` step resolves its picked skill (`stepOptions.skillId`) via the optional
// `skillResolver`. Unlike the fragment resolver (absent ⇒ static pool), a skill step dispatched
// with the resolver UNWIRED is a hard ValidationError — a skill step running against nothing is a
// silent wrong run. These pin: the resolver populates `context.skill` + pins `step.skillVersion`;
// a missing resolver throws; a skill step with no `skillId` (legacy/malformed) returns no skill;
// and a non-skill step never touches the resolver.

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: SKILL_AGENT_KIND,
    state: 'running',
    progress: 0,
    ...over,
  } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineName: 'Skill run',
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

const RESOLVED = {
  skill: {
    skillId: 'src:s:triage',
    name: 'triage',
    description: 'Triage a bug',
    instructions: '1. Reproduce',
    resources: [],
  },
  version: { skillId: 'src:s:triage', commit: 'commit-abc', sha: 'sha-1' },
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

describe('AgentContextBuilder skill resolution', () => {
  it('resolves the picked skill and pins step.skillVersion', async () => {
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const builder = makeBuilder({ skillResolver: { resolveForRun: async () => RESOLVED } })
    const context = await builder.buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skill).toEqual(RESOLVED.skill)
    expect(s.skillVersion).toEqual(RESOLVED.version)
  })

  it('throws a ValidationError when a skill was picked but no resolver is wired', async () => {
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    await expect(
      makeBuilder().buildContext('ws1', instance([s]), s, true, TASK),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('resolves no skill for a skill step that carries no skillId (legacy/malformed)', async () => {
    const s = step({ stepOptions: {} })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skill).toBeUndefined()
    expect(s.skillVersion).toBeUndefined()
  })

  it('never touches the resolver for a non-skill step', async () => {
    const s = step({ agentKind: 'coder', stepOptions: { skillId: 'src:s:triage' } })
    const context = await makeBuilder({
      skillResolver: {
        resolveForRun: async () => {
          throw new Error('should not be called for a non-skill step')
        },
      },
    }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skill).toBeUndefined()
    expect(s.skillVersion).toBeUndefined()
  })
})
