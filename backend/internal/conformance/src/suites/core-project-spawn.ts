import type {
  Project,
  ProjectOutcomeDetail,
  ProjectStageState,
  SpawnRecord,
  TaskLinkedProject,
} from '@cat-factory/contracts'
import {
  type Block,
  type ExecutionInstance,
  ProjectDefinitionRegistry,
  RESEARCH_PIPELINE_ID,
  SPAWN_PIPELINE_ID,
  type WorkspaceSnapshot,
  defaultProjectKindModuleRegistry,
  defaultProjectKindRegistry,
  eraseTaskHandler,
  researchTaskHandler,
  spawnTaskHandler,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// A spawn stage, end to end: once a research stage is accepted, the spawn stage's run (performed
// by the engine, with no agent) creates a task in each service the project links, with the project
// linked to it, and records what it created. Its checkpoint refuses acceptance until every task it
// created is done. Pins the spawn task type, its pipeline, the derived task ids that make a replay
// idempotent, and the acceptance gate on every store.

const KIND = 'delivery-study'

function registries(spawnConfig: Record<string, unknown>) {
  const kinds = defaultProjectKindRegistry()
  kinds.register({
    id: KIND,
    label: 'Delivery study',
    definition: 'required',
    taskTypes: [
      { taskType: 'research', repoAccess: 'none', defaultPipelineId: RESEARCH_PIPELINE_ID },
      { taskType: 'spawn', repoAccess: 'none', defaultPipelineId: SPAWN_PIPELINE_ID },
    ],
  })
  const modules = defaultProjectKindModuleRegistry()
  modules.register({
    kind: KIND,
    handlers: [eraseTaskHandler(researchTaskHandler), eraseTaskHandler(spawnTaskHandler)],
    parseSpec: (definition) => ({ ok: true, value: definition.spec }),
    definitionSummary: (definition) => definition.title,
  })
  const definitions = new ProjectDefinitionRegistry(modules.all())
  definitions.register({
    kind: KIND,
    key: 'acme:delivery',
    version: 1,
    title: 'Delivery study',
    spec: {},
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        checkpoint: true,
        config: {
          brief: 'Learn the vendor.',
          topics: [
            { id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which?' }] },
          ],
        },
      },
      {
        id: 'build',
        title: 'Build',
        taskType: 'spawn',
        after: ['discover'],
        produces: 'spawned',
        checkpoint: true,
        config: spawnConfig,
      },
    ],
  })
  return { kinds, modules, definitions }
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function defineCoreProjectSpawnConformance(harness: ConformanceHarness): void {
  describe('project spawn stages', () => {
    async function setup(spawnConfig: Record<string, unknown>) {
      const { kinds, modules, definitions } = registries(spawnConfig)
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        {
          projectKindRegistry: kinds,
          projectKindModuleRegistry: modules,
          projectDefinitionRegistry: definitions,
        },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const board = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const services = (board.serviceCatalog ?? []).slice(0, 2)
      expect(services.length).toBe(2)
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: KIND,
        title: 'Vendor delivery',
        definition: { key: 'acme:delivery' },
        serviceIds: services.map((s) => s.id),
      })
      expect(created.status).toBe(201)
      const project = created.body.project
      const base = `/workspaces/${wsId}/projects/${project.id}`
      const run = async (task: Block, pipelineId: string): Promise<ExecutionInstance> => {
        const started = await app.call('POST', `/workspaces/${wsId}/blocks/${task.id}/executions`, {
          pipelineId,
        })
        expect(started.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === task.id)!
      }
      const start = async (stageId: string) => {
        const task = await app.call<Block>('POST', `${base}/stages/${stageId}/tasks`)
        expect(task.status).toBe(201)
        return task.body
      }
      // The spawn stage runs after the research stage is accepted.
      expect((await run(await start('discover'), RESEARCH_PIPELINE_ID)).status).toBe('done')
      expect((await app.call('POST', `${base}/stages/discover/checkpoint`, {})).status).toBe(200)
      return { app, wsId, project, base, services, run, start }
    }

    it('creates a task in each linked service, accepted once every one is done', async () => {
      const { app, wsId, project, base, services, run, start } = await setup({
        title: 'Integrate {service}',
        description: 'Use the study in {service}.',
      })
      const spawnTask = await start('build')
      const spawned = await run(spawnTask, SPAWN_PIPELINE_ID)
      expect(spawned.status).toBe('done')
      const step = spawned.steps.find((s) => s.agentKind === 'project-spawner')!
      expect(step.project).toMatchObject({ stageId: 'build', stream: 'spawned' })

      const accepted = await app.call<ProjectOutcomeDetail>(
        'GET',
        `${base}/outcomes/pout_${spawnTask.id}`,
      )
      const record = accepted.body.body as SpawnRecord
      expect(record.skipped).toEqual([])
      expect(record.tasks.map((t) => t.serviceId)).toEqual(services.map((s) => s.id))
      // A feature task pins no pipeline, so each waits on its board for a person to start it.
      expect(record.tasks.every((t) => !t.started)).toBe(true)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      for (const [i, task] of record.tasks.entries()) {
        expect(task.taskId).toBe(`${spawnTask.id}_${services[i]!.id}`)
        const block = snap.blocks.find((b) => b.id === task.taskId)!
        const frame = snap.blocks.find((b) => b.id === services[i]!.frameBlockId)!
        expect(block.parentId).toBe(frame.id)
        expect(block.title).toBe(`Integrate ${frame.title}`)
        expect(block.description).toBe(`Use the study in ${frame.title}.`)
        const links = await app.call<{ projects: TaskLinkedProject[] }>(
          'GET',
          `/workspaces/${wsId}/blocks/${task.taskId}/projects`,
        )
        expect(links.body.projects.map((l) => l.projectId)).toEqual([project.id])
      }

      const checkpoint = `${base}/stages/build/checkpoint`
      const early = await app.call('POST', checkpoint, {})
      expect(early.status).toBe(409)
      expect(reasonOf(early.body)).toBe('project_stage_work_unsettled')

      // A person starts each task; once every one is done, the stage is accepted.
      for (const task of record.tasks) {
        const block = snap.blocks.find((b) => b.id === task.taskId)!
        const done = await run(block, 'pl_spike_direct')
        expect(done.status).toBe('done')
        // Each task read the project's accepted stages as linked context.
        expect(done.steps.find((s) => s.contextProjects?.length)?.contextProjects).toEqual([
          expect.objectContaining({ projectId: project.id }),
        ])
      }
      const cleared = await app.call<ProjectStageState>('POST', checkpoint, {})
      expect(cleared.status).toBe(200)
      expect(cleared.body.status).toBe('done')
    })

    it("starts each task's run on the stage's pipeline", async () => {
      const { app, wsId, base, run, start } = await setup({
        title: 'Spike {service}',
        description: 'Spike the vendor integration in {service}.',
        taskType: 'spike',
        pipelineId: 'pl_spike_direct',
      })
      const spawnTask = await start('build')
      expect((await run(spawnTask, SPAWN_PIPELINE_ID)).status).toBe('done')
      const accepted = await app.call<ProjectOutcomeDetail>(
        'GET',
        `${base}/outcomes/pout_${spawnTask.id}`,
      )
      const record = accepted.body.body as SpawnRecord
      expect(record.tasks.every((t) => t.started)).toBe(true)
      const runs = await app.drive(wsId)
      for (const task of record.tasks) {
        expect(runs.find((e) => e.blockId === task.taskId)?.status).toBe('done')
      }
      expect((await app.call('POST', `${base}/stages/build/checkpoint`, {})).status).toBe(200)
    })
  })
}
