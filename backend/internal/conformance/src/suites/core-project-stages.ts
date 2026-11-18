import type { Project, ProjectBoardView, ProjectStageState } from '@cat-factory/contracts'
import type { Block, ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { RESEARCH_PIPELINE_ID, defaultProjectDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Staged projects, driven by the research kind: a definition whose stages each run a research
// task over its own questions and write their own stream. A stage starts only once the stages it
// runs after have an accepted result, a checkpoint holds a result until a person accepts it, and
// a stage has one task without a result at a time. Pins the stage-task records on every store and
// the derived state a board reads.

const config = (id: string, question: string) => ({
  brief: `Answer the ${id} question.`,
  topics: [{ id: 'main', title: 'Main', questions: [{ id, question }] }],
})

function definitions() {
  const registry = defaultProjectDefinitionRegistry()
  registry.register({
    kind: 'research',
    key: 'acme:staged',
    version: 1,
    title: 'Staged vendor study',
    spec: config('scheme', 'Which auth scheme?'),
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        checkpoint: true,
        config: config('scheme', 'Which auth scheme?'),
      },
      {
        id: 'deepen',
        title: 'Deepen',
        taskType: 'research',
        after: ['discover'],
        consumes: [{ stage: 'discover' }],
        produces: 'deepening',
        config: config('paging', 'How does pagination work?'),
      },
    ],
  })
  registry.register({
    kind: 'research',
    key: 'acme:auto',
    version: 1,
    title: 'Automatic vendor study',
    spec: config('scheme', 'Which auth scheme?'),
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        start: 'auto',
        config: config('scheme', 'Which auth scheme?'),
      },
      {
        id: 'deepen',
        title: 'Deepen',
        taskType: 'research',
        after: ['discover'],
        produces: 'deepening',
        start: 'auto',
        config: config('paging', 'How does pagination work?'),
      },
    ],
  })
  return registry
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function defineCoreProjectStagesConformance(harness: ConformanceHarness): void {
  describe('project stages', () => {
    async function setup(key = 'acme:staged') {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        { projectDefinitionRegistry: definitions() },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Staged study',
        definition: { key },
      })
      expect(created.status).toBe(201)
      const project = created.body.project
      const stages = async () => {
        const view = await app.call<ProjectBoardView>(
          'GET',
          `/workspaces/${wsId}/projects/${project.id}/view`,
        )
        expect(view.status).toBe(200)
        return view.body.stages.map((s) => [s.stage.id, s.state.status])
      }
      const start = (stageId: string) =>
        app.call<Block>(
          'POST',
          `/workspaces/${wsId}/projects/${project.id}/stages/${stageId}/tasks`,
        )
      const run = async (task: Block): Promise<ExecutionInstance> => {
        const started = await app.call('POST', `/workspaces/${wsId}/blocks/${task.id}/executions`, {
          pipelineId: RESEARCH_PIPELINE_ID,
        })
        expect(started.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === task.id)!
      }
      return { app, wsId, project, stages, start, run }
    }

    it('runs a stage only once what it runs after is accepted at its checkpoint', async () => {
      const { app, wsId, project, stages, start, run } = await setup()
      expect(await stages()).toEqual([
        ['discover', 'ready'],
        ['deepen', 'blocked'],
      ])
      const early = await start('deepen')
      expect(early.status).toBe(409)
      expect(reasonOf(early.body)).toBe('project_stage_blocked')

      const task = await start('discover')
      expect(task.status).toBe(201)
      expect(task.body).toMatchObject({ title: 'Discover', taskType: 'research' })
      const again = await start('discover')
      expect(again.status).toBe(409)
      expect(reasonOf(again.body)).toBe('project_stage_in_progress')
      expect(await stages()).toEqual([
        ['discover', 'in-progress'],
        ['deepen', 'blocked'],
      ])

      const exec = await run(task.body)
      expect(exec.status).toBe('done')
      expect(exec.steps.find((s) => s.agentKind === 'project-researcher')?.project).toMatchObject({
        stageId: 'discover',
        stream: 'discovery',
        plan: { questionIds: ['scheme'] },
      })
      expect(await stages()).toEqual([
        ['discover', 'awaiting-checkpoint'],
        ['deepen', 'blocked'],
      ])
      // A person learns the result awaits acceptance from the inbox.
      const cards = async () =>
        (
          await app.call<{ type: string; blockId: string | null; status: string }[]>(
            'GET',
            `/workspaces/${wsId}/notifications`,
          )
        ).body.filter((n) => n.type === 'stage_checkpoint' && n.blockId === task.body.id)
      expect((await cards()).map((n) => n.status)).toEqual(['open'])

      // A task links the project only once a stage has an ACCEPTED result: one still awaiting
      // its checkpoint is not one.
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const frameId = snap.serviceCatalog?.[0]?.frameBlockId
      const linking = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/${frameId}/tasks`, {
        title: 'Integrate the vendor',
        description: 'Integrate the vendor API using what the staged study found.',
      })
      expect(linking.status).toBe(201)
      const link = () =>
        app.call('POST', `/workspaces/${wsId}/blocks/${linking.body.id}/projects`, {
          projectIds: [project.id],
        })
      const unaccepted = await link()
      expect(reasonOf(unaccepted.body)).toBe('project_has_no_result')

      const checkpoint = `/workspaces/${wsId}/projects/${project.id}/stages/discover/checkpoint`
      const cleared = await app.call<ProjectStageState>('POST', checkpoint, {})
      expect(cleared.status).toBe(200)
      expect(cleared.body).toMatchObject({ stageId: 'discover', status: 'done' })
      // Accepting settles the card.
      expect(await cards()).toEqual([])
      const twice = await app.call('POST', checkpoint, {})
      expect(twice.status).toBe(409)
      expect(reasonOf(twice.body)).toBe('project_stage_checkpoint_not_pending')
      expect(await stages()).toEqual([
        ['discover', 'done'],
        ['deepen', 'ready'],
      ])

      // Once accepted, the linking task reads the discovery result as the revision it reflects.
      expect((await link()).status).toBe(200)
      await app.call('POST', `/workspaces/${wsId}/blocks/${linking.body.id}/executions`, {
        pipelineId: 'pl_spike_direct',
      })
      const read = (await app.drive(wsId))
        .find((e) => e.blockId === linking.body.id)!
        .steps.find((st) => st.contextProjects?.length)
      expect(read?.contextProjects).toEqual([
        expect.objectContaining({
          projectId: project.id,
          revisionId: `pout_${task.body.id}`,
          seq: 1,
        }),
      ])

      const deeper = await start('deepen')
      expect(deeper.status).toBe(201)
      const deepened = await run(deeper.body)
      expect(
        deepened.steps.find((s) => s.agentKind === 'project-researcher')?.project,
      ).toMatchObject({
        stageId: 'deepen',
        stream: 'deepening',
        plan: { questionIds: ['paging'] },
        // It read the discovery result it started from.
        upstream: [{ stageId: 'discover', outcomeId: `pout_${task.body.id}`, seq: 1 }],
      })
      const repeat = await start('discover')
      expect(reasonOf(repeat.body)).toBe('project_stage_not_repeatable')
    })

    it('starts automatic stages on their own as each becomes ready', async () => {
      const { app, wsId, stages } = await setup('acme:auto')
      // Creating the project started the first stage; its result starts the next one, which the
      // same drive then runs.
      expect(await stages()).toEqual([
        ['discover', 'in-progress'],
        ['deepen', 'blocked'],
      ])
      await app.drive(wsId)
      const settled = await stages()
      expect(settled).toEqual([
        ['discover', 'done'],
        ['deepen', 'done'],
      ])
    })

    it('frees a stage whose task was deleted before it recorded a result', async () => {
      const { app, wsId, stages, start } = await setup()
      const task = await start('discover')
      expect(task.status).toBe(201)
      const removed = await app.call('DELETE', `/workspaces/${wsId}/blocks/${task.body.id}`)
      expect(removed.status).toBeLessThan(300)
      expect((await stages())[0]).toEqual(['discover', 'ready'])
      expect((await start('discover')).status).toBe(201)
    })

    it('refuses a task under a staged project that no stage started', async () => {
      const { app, wsId, project } = await setup()
      const task = await app.call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Off the plan', taskType: 'research' },
      )
      expect(task.status).toBe(201)
      await app.call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: RESEARCH_PIPELINE_ID,
      })
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(exec.status).toBe('failed')
      expect(exec.failure).toMatchObject({ kind: 'preflight', reason: 'project_task_has_no_stage' })
    })
  })
}
