import type { ProjectDefinition, SpawnRecord } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { decisionTaskHandler } from './decision-handler.js'
import { ProjectDefinitionRegistry } from './project-definition-registry.js'
import { eraseTaskHandler } from './project-kind-module.js'
import { spawnTaskHandler } from './spawn-handler.js'

const record: SpawnRecord = {
  tasks: [
    {
      serviceId: 'svc_a',
      serviceName: 'Api',
      workspaceId: 'ws_1',
      taskId: 'task_a',
      title: 'Integrate Api',
      started: true,
    },
    {
      serviceId: 'svc_b',
      serviceName: 'Web',
      workspaceId: 'ws_1',
      taskId: 'task_b',
      title: 'Integrate Web',
      started: false,
      note: 'A person starts it.',
    },
  ],
  skipped: [{ serviceId: 'svc_c', serviceName: null, reason: 'The service is gone.' }],
}

function registry() {
  return new ProjectDefinitionRegistry([
    {
      kind: 'delivering',
      handlers: [eraseTaskHandler(decisionTaskHandler), eraseTaskHandler(spawnTaskHandler)],
      parseSpec: (d: ProjectDefinition) => ({ ok: true, value: d.spec }),
      definitionSummary: (d: ProjectDefinition) => d.title,
    },
  ])
}

const definition = (version: number, spawn: Record<string, unknown>) => ({
  kind: 'delivering',
  key: 'acme:delivering',
  version,
  title: 'Delivering',
  spec: {},
  stages: [
    {
      id: 'decide',
      title: 'Decide',
      taskType: 'decisions',
      produces: 'decisions',
      checkpoint: true,
      config: { brief: 'Decide.' },
    },
    {
      id: 'build',
      title: 'Build',
      taskType: 'spawn',
      produces: 'spawned',
      after: ['decide'],
      checkpoint: true,
      config: { title: 'Integrate {service}' },
      ...spawn,
    },
  ],
})

describe('spawnTaskHandler', () => {
  it('awaits every task it created before its checkpoint accepts', () => {
    expect(spawnTaskHandler.checkpointAwaits?.(record)).toEqual([
      { workspaceId: 'ws_1', taskId: 'task_a' },
      { workspaceId: 'ws_1', taskId: 'task_b' },
    ])
  })

  it('renders what it created and the services it skipped', () => {
    const rendering = spawnTaskHandler.renderContext!({
      definition: null,
      inputs: {},
      stage: { id: 'build', title: 'Build', config: {} },
      outcomes: [
        {
          id: 'pout_1',
          projectId: 'prj_1',
          stream: 'spawned',
          seq: 1,
          intent: 'spawn',
          schemaVersion: 1,
          taskId: 'task_spawn',
          definitionKey: null,
          definitionVersion: null,
          artifactRefs: [],
          createdAt: 1,
          body: record,
        },
      ],
    })
    expect(rendering.coverage).toBe('2 task(s) created, 1 service(s) skipped')
    expect(rendering.body).toContain('Api: task `task_a`')
    expect(rendering.body).toContain('run not started: A person starts it.')
    expect(rendering.body).toContain('svc_c: The service is gone.')
  })

  it('refuses a stage with no checkpoint or nothing it runs after, and a project-only task type', () => {
    const definitions = registry()
    expect(() => definitions.register(definition(1, { checkpoint: false }))).toThrow(
      /must declare a checkpoint/,
    )
    expect(() => definitions.register(definition(2, { after: [] }))).toThrow(
      /must run after at least one/,
    )
    expect(() =>
      definitions.register(
        definition(3, { config: { title: 'Integrate {service}', taskType: 'research' } }),
      ),
    ).toThrow(/a task type a service runs/)
    expect(() => definitions.register(definition(4, {}))).not.toThrow()
  })
})
