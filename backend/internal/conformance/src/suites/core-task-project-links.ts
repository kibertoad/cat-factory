import type { Project, TaskLinkedProject } from '@cat-factory/contracts'
import type { Block, WorkspaceSnapshot } from '@cat-factory/kernel'
import { RESEARCH_PIPELINE_ID, ResearchDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Projects linked to tasks as read-only context: a link is admitted only for a project of the
// task's own account that has a result, the link survives the round trip through both stores, and
// a dispatch of the linked task records which findings revision it read.

function definitions(): ResearchDefinitionRegistry {
  const registry = new ResearchDefinitionRegistry()
  registry.register({
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    brief: 'Learn how the vendor integrates.',
    topics: [
      { id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which auth scheme?' }] },
    ],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  })
  return registry
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function defineCoreTaskProjectLinksConformance(harness: ConformanceHarness): void {
  describe('task project links', () => {
    async function setup() {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        { researchDefinitionRegistry: definitions() },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Vendor research',
        research: { definitionKey: 'acme:vendor' },
      })
      expect(created.status).toBe(201)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const frameId = snap.serviceCatalog?.[0]?.frameBlockId
      expect(frameId).toBeTruthy()
      const task = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/${frameId}/tasks`, {
        title: 'Integrate the vendor',
        description: 'Integrate the vendor API using what the research project found.',
      })
      expect(task.status).toBe(201)
      return { app, wsId, project: created.body.project, task: task.body }
    }

    async function research(
      app: Awaited<ReturnType<typeof setup>>['app'],
      wsId: string,
      project: Project,
    ): Promise<void> {
      const task = await app.call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Research the vendor', taskType: 'research' },
      )
      await app.call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: RESEARCH_PIPELINE_ID,
      })
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)
      expect(exec?.status).toBe('done')
    }

    it('refuses a project with no result yet, and one that does not exist', async () => {
      const { app, wsId, project, task } = await setup()
      const path = `/workspaces/${wsId}/blocks/${task.id}/projects`
      const empty = await app.call('POST', path, { projectIds: [project.id] })
      expect(empty.status).toBe(422)
      expect(reasonOf(empty.body)).toBe('project_has_no_result')
      const missing = await app.call('POST', path, { projectIds: ['prj_missing'] })
      expect(missing.status).toBe(422)
      expect(reasonOf(missing.body)).toBe('project_link_invalid')
      const listed = await app.call<{ projects: TaskLinkedProject[] }>('GET', path)
      expect(listed.body.projects).toEqual([])
    })

    it('links a researched project, and a run of the task records the revision it read', async () => {
      const { app, wsId, project, task } = await setup()
      await research(app, wsId, project)
      const path = `/workspaces/${wsId}/blocks/${task.id}/projects`
      const linked = await app.call<{ projects: TaskLinkedProject[] }>('POST', path, {
        projectIds: [project.id],
      })
      expect(linked.status).toBe(200)
      expect(linked.body.projects).toEqual([
        expect.objectContaining({
          projectId: project.id,
          kind: 'research',
          title: 'Vendor research',
        }),
      ])
      // Linking again keeps the one link.
      await app.call('POST', path, { projectIds: [project.id] })
      expect((await app.call<{ projects: unknown[] }>('GET', path)).body.projects).toHaveLength(1)

      const started = await app.call('POST', `/workspaces/${wsId}/blocks/${task.id}/executions`, {
        pipelineId: 'pl_spike_direct',
      })
      expect(started.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.id)!
      const read = exec.steps.find((s) => s.contextProjects?.length)
      expect(read?.contextProjects).toEqual([
        {
          projectId: project.id,
          title: 'Vendor research',
          kind: 'research',
          revisionId: expect.any(String),
          seq: 1,
        },
      ])

      const unlinked = await app.call('DELETE', `${path}/${project.id}`)
      expect(unlinked.status).toBe(204)
      expect((await app.call<{ projects: unknown[] }>('GET', path)).body.projects).toEqual([])
    })

    it("drops a task's links when the linked project is deleted", async () => {
      const { app, wsId, project, task } = await setup()
      await research(app, wsId, project)
      const path = `/workspaces/${wsId}/blocks/${task.id}/projects`
      await app.call('POST', path, { projectIds: [project.id] })
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const projectTasks = snap.blocks.filter((b) => b.parentId === project.rootBlockId)
      for (const child of projectTasks) {
        await app.call('DELETE', `/workspaces/${wsId}/blocks/${child.id}`)
      }
      const removed = await app.call('DELETE', `/workspaces/${wsId}/blocks/${project.rootBlockId}`)
      expect(removed.status).toBeLessThan(300)
      expect((await app.call<{ projects: unknown[] }>('GET', path)).body.projects).toEqual([])
    })
  })
}
