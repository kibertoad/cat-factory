import type { DecisionBrief, DecisionRegister, ProjectDefinition } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { decisionTaskHandler } from './decision-handler.js'
import { ProjectDefinitionRegistry } from './project-definition-registry.js'
import { eraseTaskHandler } from './project-kind-module.js'
import type { Block } from './types.js'

const config = {
  brief: 'Decide how exports behave.',
  questions: [
    { id: 'overwrite', question: 'Overwrite?' },
    { id: 'drafts', question: 'Drafts only?' },
  ],
}

const item = (id: string) => ({
  id,
  question: `${id}?`,
  options: ['yes', 'no'],
  recommendation: 'yes',
  rationale: '',
  evidence: [],
  decision: null,
})

const register = (...ids: string[]): DecisionRegister => ({
  summary: '',
  items: ids.map(item),
  unanswered: [],
})

const input = (outcomes: DecisionRegister[] = []) => ({
  task: { id: 'task_1' } as Block,
  definition: null,
  inputs: {},
  stage: { id: 'decide', config },
  outcomes: outcomes.map((body, i) => ({
    id: `pout_${i}`,
    projectId: 'prj_1',
    stream: 'decisions',
    seq: i + 1,
    intent: 'propose',
    schemaVersion: 1,
    taskId: `task_${i}`,
    definitionKey: null,
    definitionVersion: null,
    artifactRefs: [],
    createdAt: i,
    body,
  })),
})

describe('decisionTaskHandler', () => {
  it('names a required question the proposal left out, in the body and the output', () => {
    const plan = decisionTaskHandler.planTask(input()).plan
    const { body, output } = decisionTaskHandler.finish({
      plan,
      seq: 1,
      reply: register('overwrite'),
    })
    expect(body.unanswered).toEqual(['drafts'])
    expect(output).toContain('left out required question(s): drafts')
  })

  it('keeps what a stopped dispatch proposed when the resumed one adds the rest', () => {
    const plan = decisionTaskHandler.planTask(input()).plan
    const { body } = decisionTaskHandler.finish({
      plan,
      seq: 1,
      reply: register('drafts'),
      checkpoint: register('overwrite'),
    })
    expect(body.items.map((i) => i.id)).toEqual(['overwrite', 'drafts'])
    expect(body.unanswered).toEqual([])
  })

  it("hands a rerun the stage's last register to carry forward", () => {
    const settled = register('overwrite')
    const brief = decisionTaskHandler.brief({ ...input([settled]), plan: {} }) as DecisionBrief
    expect(brief.prior).toEqual(settled)
  })

  it('refuses a task under a definition that declares no stages, naming why', () => {
    expect(() => decisionTaskHandler.planTask({ ...input(), stage: null })).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'project_task_type_needs_stage' }),
      }),
    )
  })

  it('refuses a decisions stage with no checkpoint, since a person must settle it', () => {
    const registry = new ProjectDefinitionRegistry([
      {
        kind: 'deciding',
        handlers: [eraseTaskHandler(decisionTaskHandler)],
        parseSpec: (d: ProjectDefinition) => ({ ok: true, value: d.spec }),
        definitionSummary: (d: ProjectDefinition) => d.title,
      },
    ])
    const definition = (checkpoint: boolean) => ({
      kind: 'deciding',
      key: 'acme:deciding',
      version: checkpoint ? 2 : 1,
      title: 'Deciding',
      spec: {},
      stages: [
        {
          id: 'decide',
          title: 'Decide',
          taskType: 'decisions',
          produces: 'decisions',
          checkpoint,
          config,
        },
      ],
    })
    expect(() => registry.register(definition(false))).toThrow(/must declare a checkpoint/)
    expect(() => registry.register(definition(true))).not.toThrow()
  })
})
