import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry, ValidationError } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry, SKILL_AGENT_KIND } from '@cat-factory/agents'

// A dispatch's skills come from two places: the `skill` step's own pick (`stepOptions.skillId`)
// and the running agent KIND's declared playbooks (bundled in code, or referenced from the
// account catalog). Both resolve through the optional `skillResolver` for catalog entries; unlike
// the fragment resolver (absent ⇒ static pool), a REQUIRED skill with the resolver UNWIRED is a
// hard ValidationError — a step asked to apply a skill and running against nothing is a silent
// wrong run. These pin: the resolver populates `context.skills` + pins `step.skillVersions`; a
// missing resolver throws; a skill step with no `skillId` (legacy/malformed) resolves nothing; a
// non-skill step never touches the resolver; a kind's BUNDLED skill needs no resolver at all; and
// an `optional` catalog skill degrades rather than failing the run.

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
    origin: 'catalog' as const,
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
  it('resolves the picked skill and pins step.skillVersions', async () => {
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const builder = makeBuilder({ skillResolver: { resolveForRun: async () => RESOLVED } })
    const context = await builder.buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skills).toEqual([RESOLVED.skill])
    expect(s.skillVersions).toEqual([RESOLVED.version])
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
    expect(context.skills).toBeUndefined()
    expect(s.skillVersions).toBeUndefined()
  })

  it('CLEARS a stale pin when a re-dispatched step no longer resolves any skill', async () => {
    // The pin says "this run executed that version". A step re-dispatched after its pick was
    // removed takes the no-skills path, so clearing has to happen there too — otherwise the step
    // keeps reporting the PRIOR round's skill as the one this run ran.
    const s = step({ stepOptions: {} })
    s.skillVersions = [RESOLVED.version]
    await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(s.skillVersions).toBeUndefined()
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
    expect(context.skills).toBeUndefined()
    expect(s.skillVersions).toBeUndefined()
  })

  it('applies a kind’s BUNDLED skill with no resolver wired, and pins no version for it', async () => {
    // A bundled skill ships in the deployment's own code, so it needs no skill library, no GitHub
    // connection and no catalog — which is what lets a custom agent package carry its own playbook.
    const registry = defaultAgentKindRegistry()
    registry.registerSkill({
      id: 'house-review',
      name: 'house-review',
      description: 'The house review playbook',
      instructions: 'Check the seams first.',
    })
    registry.register({
      kind: 'org-reviewer',
      systemPrompt: 'You review.',
      skills: ['house-review'],
      agent: { surface: 'container-explore' },
    })
    const s = step({ agentKind: 'org-reviewer' })
    const context = await makeBuilder({ agentKindRegistry: registry }).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['house-review'])
    expect(context.skills?.[0]?.origin).toBe('bundled')
    // A bundled skill's version IS the deployment's, so there is nothing to pin.
    expect(s.skillVersions).toBeUndefined()
  })

  it('applies a skill the DEPLOYMENT assigned, read from a source this build does not hold', async () => {
    // Mothership mode: the org attached its house playbook to a BUILT-IN kind, and this node's
    // build knows nothing about it. Before the source, the dispatch simply went without — the
    // agent did the work its own way, which reads exactly like an agent that considered the
    // standard and moved on. The MERGE is the point: the kind's executable half stays local.
    const ORG_SKILL = {
      id: 'org.playbook',
      name: 'org-playbook',
      description: 'The org playbook',
      instructions: 'Follow the house pattern.',
    }
    const ORG_SERVER = {
      id: 'org.tracker',
      transport: { kind: 'stdio' as const, command: 'tracker-mcp', args: [] },
    }
    const s = step({ agentKind: 'coder' })
    const context = await makeBuilder({
      agentKindSource: {
        capabilities: async () => [
          {
            kind: 'coder',
            skills: { bundled: [ORG_SKILL], catalog: [], unknown: [] },
            toolServers: { servers: [ORG_SERVER], unknown: [] },
          },
        ],
      },
    }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skills?.map((skill) => skill.skillId)).toEqual([ORG_SKILL.id])
    // The tool-server half rides the context to the executor, which owns servability.
    expect(context.orgToolServers?.servers.map((server) => server.id)).toEqual([ORG_SERVER.id])
  })

  it('carries the org layer’s UNRESOLVABLE tool-server ids too, with no servers of its own', async () => {
    // An id the MOTHERSHIP could not resolve is a typo in the org's own package, and a node
    // boot-validates nothing it reads remotely: the dispatch warn is the only place it can be
    // reported, so the layer has to arrive even when it resolved no server at all.
    const s = step({ agentKind: 'coder' })
    const context = await makeBuilder({
      agentKindSource: {
        capabilities: async () => [
          {
            kind: 'coder',
            skills: { bundled: [], catalog: [], unknown: [] },
            toolServers: { servers: [], unknown: ['org.typo'] },
          },
        ],
      },
    }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.orgToolServers).toEqual({ servers: [], unknown: ['org.typo'] })
  })

  it('carries no org tool servers when no source is wired (byte-for-byte the prior behaviour)', async () => {
    const s = step({ agentKind: 'coder' })
    const context = await makeBuilder().buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.orgToolServers).toBeUndefined()
  })

  it('a kind’s REQUIRED catalog skill fails the dispatch when it cannot resolve', async () => {
    const registry = defaultAgentKindRegistry()
    registry.register({
      kind: 'org-reviewer',
      systemPrompt: 'You review.',
      skills: [{ catalogSkillId: 'src:s:triage' }],
      agent: { surface: 'container-explore' },
    })
    const s = step({ agentKind: 'org-reviewer' })
    await expect(
      makeBuilder({ agentKindRegistry: registry }).buildContext(
        'ws1',
        instance([s]),
        s,
        true,
        TASK,
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('an OPTIONAL catalog skill degrades to no skill instead of failing the run', async () => {
    const registry = defaultAgentKindRegistry()
    registry.register({
      kind: 'org-reviewer',
      systemPrompt: 'You review.',
      skills: [{ catalogSkillId: 'src:s:triage', optional: true }],
      agent: { surface: 'container-explore' },
    })
    const s = step({ agentKind: 'org-reviewer' })
    // Both failure modes degrade: no resolver wired at all, and a resolver that throws.
    const unwired = await makeBuilder({ agentKindRegistry: registry }).buildContext(
      'ws1',
      instance([s]),
      s,
      true,
      TASK,
    )
    expect(unwired.skills).toBeUndefined()
    const broken = await makeBuilder({
      agentKindRegistry: registry,
      skillResolver: {
        resolveForRun: async () => {
          throw new Error('skill was removed upstream')
        },
      },
    }).buildContext('ws1', instance([step({ agentKind: 'org-reviewer' })]), s, true, TASK)
    expect(broken.skills).toBeUndefined()
  })

  it('dedups a step pick the kind already declares, keeping the kind’s order', async () => {
    const registry = defaultAgentKindRegistry()
    registry.registerSkill({
      id: 'house-review',
      name: 'house-review',
      description: 'The house review playbook',
      instructions: 'Check the seams first.',
    })
    registry.assignSkills(SKILL_AGENT_KIND, ['house-review'])
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const context = await makeBuilder({
      agentKindRegistry: registry,
      skillResolver: { resolveForRun: async () => RESOLVED },
    }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['house-review', 'src:s:triage'])
  })
})
