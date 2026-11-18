import type {
  PublicProject,
  PublicProjectOutcomeList,
  PublicProjectStageList,
  PublicProjectTask,
} from '@cat-factory/contracts'
import { defaultProjectDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for a staged project's stages on the public API: listing them with
// their derived state, starting one, and accepting its checkpoint, which takes a `decide` key.
// Facade-run because only a facade shows each route is MOUNTED.

function definitions() {
  const registry = defaultProjectDefinitionRegistry()
  const config = (id: string) => ({
    brief: `Answer the ${id} question.`,
    topics: [{ id: 'main', title: 'Main', questions: [{ id, question: `What about ${id}?` }] }],
  })
  registry.register({
    kind: 'research',
    key: 'platform:staged',
    version: 1,
    title: 'Staged vendor study',
    spec: config('scheme'),
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        checkpoint: true,
        config: config('scheme'),
      },
      {
        id: 'deepen',
        title: 'Deepen',
        taskType: 'research',
        after: ['discover'],
        produces: 'deepening',
        config: config('paging'),
      },
    ],
  })
  return registry
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function definePublicProjectStagesConformance(harness: ConformanceHarness): void {
  describe('public API: project stages', () => {
    async function setup() {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        { projectDefinitionRegistry: definitions() },
      )
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'projects')
      const decide = await mintPublicApiKey(app, workspace.id, 'decide', 'projects')
      return { app, wsId: workspace.id, write, decide }
    }

    it('lists, starts and accepts the stages of a staged project', async () => {
      const { app, wsId, write, decide } = await setup()
      const created = await app.call<PublicProject>(
        'POST',
        '/api/v1/projects',
        { kind: 'research', title: 'Staged study', definition: { key: 'platform:staged' } },
        write,
      )
      expect(created.status).toBe(201)
      const base = `/api/v1/projects/${created.body.projectId}`
      const statuses = async () => {
        const listed = await app.call<PublicProjectStageList>(
          'GET',
          `${base}/stages`,
          undefined,
          write,
        )
        expect(listed.status).toBe(200)
        return listed.body.stages.map((s) => [s.stage.id, s.state.status])
      }
      expect(await statuses()).toEqual([
        ['discover', 'ready'],
        ['deepen', 'blocked'],
      ])
      const blocked = await app.call('POST', `${base}/stages/deepen/tasks`, undefined, write)
      expect(blocked.status).toBe(409)
      expect(reasonOf(blocked.body)).toBe('project_stage_blocked')

      const task = await app.call<PublicProjectTask>(
        'POST',
        `${base}/stages/discover/tasks`,
        undefined,
        write,
      )
      expect(task.status).toBe(201)
      expect(task.body).toMatchObject({ projectId: created.body.projectId, taskType: 'research' })
      const started = await app.call('POST', `${base}/tasks/${task.body.taskId}/start`, {}, decide)
      expect(started.status).toBe(202)
      await app.drive(wsId)
      expect(await statuses()).toEqual([
        ['discover', 'awaiting-checkpoint'],
        ['deepen', 'blocked'],
      ])

      // Accepting answers a checkpoint, so a write key is refused and a decide key accepts.
      const byWrite = await app.call('POST', `${base}/stages/discover/checkpoint`, {}, write)
      expect(byWrite.status).toBe(403)
      const accepted = await app.call<{ status: string }>(
        'POST',
        `${base}/stages/discover/checkpoint`,
        {},
        decide,
      )
      expect(accepted.status).toBe(200)
      expect(accepted.body.status).toBe('done')
      const outcomes = await app.call<PublicProjectOutcomeList>(
        'GET',
        `${base}/outcomes`,
        undefined,
        write,
      )
      expect(outcomes.body.outcomes).toEqual([
        expect.objectContaining({ stream: 'discovery', taskType: 'research' }),
      ])
      expect(await statuses()).toEqual([
        ['discover', 'done'],
        ['deepen', 'ready'],
      ])
    })
  })
}
