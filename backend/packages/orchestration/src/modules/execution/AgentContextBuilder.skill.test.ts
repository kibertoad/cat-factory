import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { InitiativePresetRegistry, ValidationError } from '@cat-factory/kernel'
import { AgentContextBuilder, type AgentContextBuilderDeps } from './AgentContextBuilder.js'
import { defaultAgentKindRegistry, PR_REVIEWER_KIND, SKILL_AGENT_KIND } from '@cat-factory/agents'
import { SKILL_UNAVAILABLE_REASON } from '@cat-factory/contracts'

// A dispatch's skills come from three places: the `skill` step's own pick (`stepOptions.skillId`),
// the running agent KIND's declared playbooks (bundled in code, or referenced from the
// account catalog), and the TASK's own queue (a review task's specialist lenses, which reach only
// a kind carrying the `review-skills` trait). Each resolves through the optional `skillResolver`
// for catalog entries; unlike the fragment resolver (absent ⇒ static pool), a REQUIRED skill with
// the resolver UNWIRED is a hard ValidationError — a step asked to apply a skill and running
// against nothing is a silent wrong run. These pin: the resolver populates `context.skills` and
// pins `step.skillVersions`; a missing resolver throws; a skill step with no `skillId` (legacy/malformed) resolves nothing; a
// non-skill step never touches the resolver; a kind's BUNDLED skill needs no resolver at all; and
// an `optional` catalog skill degrades rather than failing the run. The task queue's own rules
// (who receives it, and that a vanished queued skill fails loudly) are pinned at the bottom.

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

/**
 * A `SkillResolver` double built from the per-skill answer alone: the batch method maps the
 * singular one, which is the same relation the real resolver has in reverse (it batches, and its
 * singular method is the one-id case). What these tests are about is WHICH skills resolve and what
 * happens when one cannot, so a double that shares one answer for both entry points keeps every
 * case honest without restating it twice. The batch's own read-count guarantees are pinned where
 * they live, in `SkillRunResolver.test.ts`.
 */
function skillResolver(
  resolveForRun: (workspaceId: string, skillId: string) => Promise<typeof RESOLVED>,
) {
  return {
    resolveForRun,
    resolveManyForRun: async (workspaceId: string, skillIds: readonly string[]) => {
      const out = []
      for (const id of skillIds) out.push(await resolveForRun(workspaceId, id))
      return out
    },
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

describe('AgentContextBuilder skill resolution', () => {
  it('resolves the picked skill and pins step.skillVersions', async () => {
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const builder = makeBuilder({ skillResolver: skillResolver(async () => RESOLVED) })
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
      skillResolver: skillResolver(async () => {
        throw new Error('should not be called for a non-skill step')
      }),
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
      skillResolver: skillResolver(async () => {
        throw new Error('skill was removed upstream')
      }),
    }).buildContext('ws1', instance([step({ agentKind: 'org-reviewer' })]), s, true, TASK)
    expect(broken.skills).toBeUndefined()
  })

  it('names the pipeline STEP as the remedy when its pick has left the catalog', async () => {
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const build = makeBuilder({
      skillResolver: skillResolver(async () => {
        throw new ValidationError(`Skill 'src:s:triage' is no longer available.`, {
          reason: SKILL_UNAVAILABLE_REASON,
          skillId: 'src:s:triage',
        })
      }),
    })
    await expect(build.buildContext('ws1', instance([s]), s, true, TASK)).rejects.toThrow(
      /no longer available.*pipeline step/s,
    )
  })

  it('propagates an outage on the step pick unchanged', async () => {
    // Same split as the task queue: only the catalog's "no such skill" earns a remedy, because
    // only that one is fixed by re-picking. Everything else is an outage wearing its own class.
    const s = step({ stepOptions: { skillId: 'src:s:triage' } })
    const outage = new Error('D1_ERROR: network')
    const build = makeBuilder({
      skillResolver: skillResolver(async () => {
        throw outage
      }),
    })
    await expect(build.buildContext('ws1', instance([s]), s, true, TASK)).rejects.toBe(outage)
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
      skillResolver: skillResolver(async () => RESOLVED),
    }).buildContext('ws1', instance([s]), s, true, TASK)
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['house-review', 'src:s:triage'])
  })
})

describe('a review task’s queued skills', () => {
  const REVIEW_TASK = {
    ...TASK,
    taskType: 'review',
    taskTypeFields: { prNumber: 42, reviewSkillIds: ['src:s:security', 'src:s:perf'] },
  } as unknown as Block

  function resolverFor(known: Record<string, string>) {
    return skillResolver(async (_ws: string, skillId: string) => {
      const name = known[skillId]
      // The real resolver's refusal shape, `reason` included: that code is what tells the engine
      // this is a vanished skill rather than a store it could not reach, and a double that omits
      // it would assert the remedy on a path the engine no longer takes it.
      if (!name) {
        throw new ValidationError(`Skill '${skillId}' is no longer available.`, {
          reason: SKILL_UNAVAILABLE_REASON,
          skillId,
        })
      }
      return {
        skill: {
          skillId,
          origin: 'catalog' as const,
          name,
          description: `The ${name} playbook`,
          instructions: `Apply ${name}.`,
          resources: [],
        },
        version: { skillId, commit: 'commit-abc', sha: `sha-${name}` },
      }
    })
  }

  it('reaches the reviewer in the order they were queued, pinning each version', async () => {
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const context = await makeBuilder({
      skillResolver: resolverFor({ 'src:s:security': 'security', 'src:s:perf': 'perf' }),
    }).buildContext('ws1', instance([s]), s, true, REVIEW_TASK)
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['src:s:security', 'src:s:perf'])
    expect(s.skillVersions?.map((v) => v.skillId)).toEqual(['src:s:security', 'src:s:perf'])
  })

  it('does NOT reach a kind without the review-skills trait', async () => {
    // The queue is a property of the review TASK, and a build pipeline's steps run on the same
    // block shape. Without the trait gate a coder would silently inherit review lenses.
    const s = step({ agentKind: 'coder' })
    const context = await makeBuilder({
      skillResolver: resolverFor({ 'src:s:security': 'security', 'src:s:perf': 'perf' }),
    }).buildContext('ws1', instance([s]), s, true, REVIEW_TASK)
    expect(context.skills).toBeUndefined()
  })

  it('FAILS the dispatch when a queued skill has left the catalog, naming the task', async () => {
    // Never optional: a review that quietly drops the security lens it was asked for reads as a
    // clean review. The message has to send the human to the task, not to the pipeline step.
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const build = makeBuilder({ skillResolver: resolverFor({ 'src:s:security': 'security' }) })
    await expect(build.buildContext('ws1', instance([s]), s, true, REVIEW_TASK)).rejects.toThrow(
      /no longer available.*task’s skills/s,
    )
  })

  it('fails a queue it cannot resolve at all when no skill library is wired', async () => {
    const s = step({ agentKind: PR_REVIEWER_KIND })
    await expect(
      makeBuilder().buildContext('ws1', instance([s]), s, true, REVIEW_TASK),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('runs a queued skill the reviewer’s kind already declares exactly once', async () => {
    const registry = defaultAgentKindRegistry()
    registry.registerSkill({
      id: 'src:s:security',
      name: 'security',
      description: 'The house security playbook',
      instructions: 'Check the auth paths.',
    })
    registry.assignSkills(PR_REVIEWER_KIND, ['src:s:security'])
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const context = await makeBuilder({
      agentKindRegistry: registry,
      skillResolver: resolverFor({ 'src:s:perf': 'perf' }),
    }).buildContext('ws1', instance([s]), s, true, REVIEW_TASK)
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['src:s:security', 'src:s:perf'])
    // The declared half is BUNDLED, so only the queued half pins a catalog version.
    expect(s.skillVersions?.map((v) => v.skillId)).toEqual(['src:s:perf'])
  })

  it('folds a playbook named twice in one queue exactly once', async () => {
    // A queue is an ordered list somebody authored, so it can repeat an id. Folded twice, that
    // playbook's instructions ride EVERY turn of the review a second time and pin a duplicate
    // version, which reads as two lenses where one ran.
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const task = {
      ...REVIEW_TASK,
      taskTypeFields: { reviewSkillIds: ['src:s:security', 'src:s:perf', 'src:s:security'] },
    } as unknown as Block
    const context = await makeBuilder({
      skillResolver: resolverFor({ 'src:s:security': 'security', 'src:s:perf': 'perf' }),
    }).buildContext('ws1', instance([s]), s, true, task)
    expect(context.skills?.map((sk) => sk.skillId)).toEqual(['src:s:security', 'src:s:perf'])
    expect(s.skillVersions?.map((v) => v.skillId)).toEqual(['src:s:security', 'src:s:perf'])
  })

  it('propagates an OUTAGE as itself rather than re-labelling it a bad pick', async () => {
    // The two failures need opposite reactions: a vanished skill is fixed by editing the queue,
    // an unreachable store by waiting or fixing the deployment. Appending "edit the task's
    // skills" to a transport failure sends an operator to change something already correct, and
    // rebuilding the error drops the class its own handler branches on.
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const outage = new Error('persistence RPC unreachable')
    const build = makeBuilder({
      skillResolver: skillResolver(async () => {
        throw outage
      }),
    })
    await expect(build.buildContext('ws1', instance([s]), s, true, REVIEW_TASK)).rejects.toBe(
      outage,
    )
  })

  it('keeps the machine-readable skillId when it appends the remedy', async () => {
    // The SPA reads `details.skillId` to point at the offending entry; rebuilding the refusal
    // without carrying the resolver's own details would leave it with prose alone.
    const s = step({ agentKind: PR_REVIEWER_KIND })
    const build = makeBuilder({ skillResolver: resolverFor({ 'src:s:security': 'security' }) })
    const error = await build
      .buildContext('ws1', instance([s]), s, true, REVIEW_TASK)
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details).toMatchObject({
      reason: SKILL_UNAVAILABLE_REASON,
      skillId: 'src:s:perf',
    })
  })
})
