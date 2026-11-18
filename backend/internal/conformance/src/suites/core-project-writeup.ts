import type { Project, ProjectOutcomeDetail, Writeup } from '@cat-factory/contracts'
import {
  type Block,
  type ExecutionInstance,
  ProjectDefinitionRegistry,
  RESEARCH_PIPELINE_ID,
  WRITEUP_PIPELINE_ID,
  defaultProjectKindModuleRegistry,
  defaultProjectKindRegistry,
  eraseTaskHandler,
  researchTaskHandler,
  writeupTaskHandler,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// A document stage, end to end, under a kind that offers both built-in handlers: a research stage
// finds, a writeup stage reads it and composes one Markdown document. The platform names the
// outline sections the document lacks and drops an artifact no result it read holds. Pins the
// writeup task type, its pipeline and both checks on every store.

const KIND = 'handoff-study'

function registries() {
  const kinds = defaultProjectKindRegistry()
  kinds.register({
    id: KIND,
    label: 'Handoff study',
    definition: 'required',
    taskTypes: [
      { taskType: 'research', repoAccess: 'none', defaultPipelineId: RESEARCH_PIPELINE_ID },
      { taskType: 'writeup', repoAccess: 'none', defaultPipelineId: WRITEUP_PIPELINE_ID },
    ],
  })
  const modules = defaultProjectKindModuleRegistry()
  modules.register({
    kind: KIND,
    handlers: [eraseTaskHandler(researchTaskHandler), eraseTaskHandler(writeupTaskHandler)],
    parseSpec: (definition) => ({ ok: true, value: definition.spec }),
    definitionSummary: (definition) => definition.title,
  })
  const definitions = new ProjectDefinitionRegistry(modules.all())
  definitions.register({
    kind: KIND,
    key: 'acme:handoff',
    version: 1,
    title: 'Handoff study',
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
        id: 'handoff',
        title: 'Handoff',
        taskType: 'writeup',
        after: ['discover'],
        consumes: [{ stage: 'discover' }],
        produces: 'handoff',
        config: {
          brief: 'Write the handoff for the team that integrates the vendor.',
          outline: ['Summary', 'Open questions'],
        },
      },
    ],
  })
  return { kinds, modules, definitions }
}

export function defineCoreProjectWriteupConformance(harness: ConformanceHarness): void {
  describe('project writeup stages', () => {
    it('composes a document from the stages it reads, naming what it lacks', async () => {
      const { kinds, modules, definitions } = registries()
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher', 'project-writer'] },
        {
          projectKindRegistry: kinds,
          projectKindModuleRegistry: modules,
          projectDefinitionRegistry: definitions,
        },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: KIND,
        title: 'Vendor handoff',
        definition: { key: 'acme:handoff' },
      })
      expect(created.status).toBe(201)
      const base = `/workspaces/${wsId}/projects/${created.body.project.id}`
      const run = async (stageId: string, pipelineId: string): Promise<ExecutionInstance> => {
        const task = await app.call<Block>('POST', `${base}/stages/${stageId}/tasks`)
        expect(task.status).toBe(201)
        const started = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          { pipelineId },
        )
        expect(started.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      }

      expect((await run('discover', RESEARCH_PIPELINE_ID)).status).toBe('done')
      expect((await app.call('POST', `${base}/stages/discover/checkpoint`, {})).status).toBe(200)
      const written = await run('handoff', WRITEUP_PIPELINE_ID)
      expect(written.status).toBe('done')
      const step = written.steps.find((s) => s.agentKind === 'project-writer')!
      expect(step.project).toMatchObject({
        stageId: 'handoff',
        stream: 'handoff',
        upstream: [expect.objectContaining({ stageId: 'discover' })],
      })

      const detail = await app.call<ProjectOutcomeDetail>(
        'GET',
        `${base}/outcomes/pout_${written.blockId}`,
      )
      const doc = detail.body.body as Writeup
      expect(doc.markdown).toContain('## Summary')
      expect(doc.missingSections).toEqual(['Open questions'])
      expect(doc.droppedArtifacts).toEqual(['artifact-not-held'])
      expect(doc.artifacts).toEqual([])
    })
  })
}
