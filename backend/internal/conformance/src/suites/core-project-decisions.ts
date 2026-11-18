import type {
  Project,
  ProjectBoardView,
  ProjectOutcomeDetail,
  ProjectStageState,
} from '@cat-factory/contracts'
import {
  type Block,
  DECISIONS_PIPELINE_ID,
  type ExecutionInstance,
  ProjectDefinitionRegistry,
  RESEARCH_PIPELINE_ID,
  decisionTaskHandler,
  defaultProjectKindModuleRegistry,
  defaultProjectKindRegistry,
  eraseTaskHandler,
  researchTaskHandler,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// A decision stage, end to end, under a kind that offers both built-in handlers: a research stage
// finds, a decision stage reads it and proposes a register, and a person settles every item at the
// checkpoint. The settled register is recorded as a revision beside the proposal and is the stage's
// accepted result. Pins the decisions task type, its pipeline and the checkpoint revision path on
// every store.

const KIND = 'integration-study'

function registries() {
  const kinds = defaultProjectKindRegistry()
  kinds.register({
    id: KIND,
    label: 'Integration study',
    definition: 'required',
    taskTypes: [
      { taskType: 'research', repoAccess: 'none', defaultPipelineId: RESEARCH_PIPELINE_ID },
      { taskType: 'decisions', repoAccess: 'none', defaultPipelineId: DECISIONS_PIPELINE_ID },
    ],
  })
  const modules = defaultProjectKindModuleRegistry()
  modules.register({
    kind: KIND,
    handlers: [eraseTaskHandler(researchTaskHandler), eraseTaskHandler(decisionTaskHandler)],
    parseSpec: (definition) => ({ ok: true, value: definition.spec }),
    definitionSummary: (definition) => definition.title,
  })
  const definitions = new ProjectDefinitionRegistry(modules.all())
  definitions.register({
    kind: KIND,
    key: 'acme:integration',
    version: 1,
    title: 'Integration study',
    spec: {},
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        config: {
          brief: 'Learn the vendor.',
          topics: [
            { id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which?' }] },
          ],
        },
      },
      {
        id: 'decide',
        title: 'Decide',
        taskType: 'decisions',
        after: ['discover'],
        consumes: [{ stage: 'discover' }],
        produces: 'decisions',
        checkpoint: true,
        config: {
          brief: 'Decide how exports behave.',
          questions: [{ id: 'overwrite', question: 'Overwrite existing translations?' }],
        },
      },
    ],
  })
  return { kinds, modules, definitions }
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function defineCoreProjectDecisionsConformance(harness: ConformanceHarness): void {
  describe('project decision stages', () => {
    it('proposes a register from what earlier stages found, settled by a person', async () => {
      const { kinds, modules, definitions } = registries()
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher', 'project-decider'] },
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
        title: 'Vendor integration',
        definition: { key: 'acme:integration' },
      })
      expect(created.status).toBe(201)
      const project = created.body.project
      const base = `/workspaces/${wsId}/projects/${project.id}`
      const run = async (stageId: string, pipelineId: string): Promise<ExecutionInstance> => {
        const task = await app.call<Block>('POST', `${base}/stages/${stageId}/tasks`)
        expect(task.status).toBe(201)
        const started = await app.call(
          'POST',
          `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
          {
            pipelineId,
          },
        )
        expect(started.status).toBe(201)
        return (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      }

      expect((await run('discover', RESEARCH_PIPELINE_ID)).status).toBe('done')
      const decided = await run('decide', DECISIONS_PIPELINE_ID)
      expect(decided.status).toBe('done')
      const step = decided.steps.find((s) => s.agentKind === 'project-decider')!
      expect(step.project).toMatchObject({ stageId: 'decide', stream: 'decisions' })
      expect(step.output).toContain('awaiting a person')

      const checkpoint = `${base}/stages/decide/checkpoint`
      const bare = await app.call('POST', checkpoint, {})
      expect(bare.status).toBe(422)
      expect(reasonOf(bare.body)).toBe('project_stage_revision_required')
      const partial = await app.call('POST', checkpoint, { revision: { decisions: [] } })
      expect(reasonOf(partial.body)).toBe('project_stage_revision_invalid')

      const settled = await app.call<ProjectStageState>('POST', checkpoint, {
        revision: { decisions: [{ itemId: 'overwrite', choice: 'yes', note: 'Lokalise wins' }] },
      })
      expect(settled.status).toBe(200)
      expect(settled.body.status).toBe('done')
      const accepted = settled.body.accepted!
      expect(accepted.id).toMatch(/_rev\d+$/)

      const view = await app.call<ProjectBoardView>('GET', `${base}/view`)
      expect(
        view.body.outcomes.filter((o) => o.stream === 'decisions').map((o) => o.intent),
      ).toEqual(['propose', 'revise'])
      const detail = await app.call<ProjectOutcomeDetail>('GET', `${base}/outcomes/${accepted.id}`)
      expect(detail.body.body).toMatchObject({
        items: [{ id: 'overwrite', decision: { choice: 'yes', note: 'Lokalise wins' } }],
      })
    })
  })
}
