import type { Project, ProjectBoardView, StageAcceptanceReport } from '@cat-factory/contracts'
import {
  type Block,
  RESEARCH_PIPELINE_ID,
  type StageAcceptanceAssessor,
  type StageAcceptanceSubject,
  defaultProjectDefinitionRegistry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// A stage's exit criteria, end to end: once its task records a result, the assessor argues each
// criterion and the platform computes the report from the passages it quotes, shown on the stage
// at its checkpoint. Pins the report on the stage-task record and the stage's state on every
// store, with a deterministic assessor in place of a model.

function definitions() {
  const registry = defaultProjectDefinitionRegistry()
  const config = {
    brief: 'Answer the scheme question.',
    topics: [{ id: 'main', title: 'Main', questions: [{ id: 'scheme', question: 'Which?' }] }],
  }
  registry.register({
    kind: 'research',
    key: 'acme:accepted',
    version: 1,
    title: 'Vendor study with exit criteria',
    spec: config,
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
    stages: [
      {
        id: 'discover',
        title: 'Discover',
        taskType: 'research',
        produces: 'discovery',
        checkpoint: true,
        config,
        acceptance: [
          { id: 'quoted', statement: 'The result answers the scheme question.' },
          { id: 'invented', statement: 'The result names the rate limits.' },
          { id: 'missing', statement: 'The result lists the error codes.' },
        ],
      },
    ],
  })
  return registry
}

/** Argues `quoted` from the result itself, `invented` from a passage it does not hold. */
function fakeAssessor(
  enabled = true,
): StageAcceptanceAssessor & { subjects: StageAcceptanceSubject[] } {
  const subjects: StageAcceptanceSubject[] = []
  return {
    enabled,
    subjects,
    assess: async (subject) => {
      subjects.push(subject)
      const passage = subject.result
        .trim()
        .split('\n')
        .find((line) => line.trim().length > 20)
      return {
        model: 'fake:acceptance',
        reply: {
          criteria: [
            { id: 'quoted', claim: 'met', rationale: 'It says so.', evidence: [passage ?? ''] },
            {
              id: 'invented',
              claim: 'met',
              rationale: 'Assumed.',
              evidence: ['The limit is 7 requests per second per tenant.'],
            },
          ],
        },
      }
    },
  }
}

export function defineCoreProjectAcceptanceConformance(harness: ConformanceHarness): void {
  describe('project stage acceptance criteria', () => {
    async function assessed(assessor: StageAcceptanceAssessor) {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        { projectDefinitionRegistry: definitions(), stageAcceptanceAssessor: assessor },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Accepted study',
        definition: { key: 'acme:accepted' },
      })
      expect(created.status).toBe(201)
      const base = `/workspaces/${wsId}/projects/${created.body.project.id}`
      const task = await app.call<Block>('POST', `${base}/stages/discover/tasks`)
      expect(task.status).toBe(201)
      await app.call('POST', `/workspaces/${wsId}/blocks/${task.body.id}/executions`, {
        pipelineId: RESEARCH_PIPELINE_ID,
      })
      expect((await app.drive(wsId)).find((e) => e.blockId === task.body.id)?.status).toBe('done')
      const view = await app.call<ProjectBoardView>('GET', `${base}/view`)
      const stage = view.body.stages.find((s) => s.stage.id === 'discover')!
      expect(stage.state.status).toBe('awaiting-checkpoint')
      return { report: stage.state.acceptance as StageAcceptanceReport, taskId: task.body.id }
    }

    it('reports each criterion from the passages the assessment quotes', async () => {
      const assessor = fakeAssessor()
      const { report, taskId } = await assessed(assessor)
      expect(assessor.subjects).toHaveLength(1)
      expect(assessor.subjects[0]!.criteria.map((c) => c.id)).toEqual([
        'quoted',
        'invented',
        'missing',
      ])
      expect(report).toMatchObject({ outcomeId: `pout_${taskId}`, state: 'assessed' })
      expect(report.criteria.map((c) => [c.id, c.status])).toEqual([
        ['quoted', 'met'],
        ['invented', 'unverified'],
        ['missing', 'unverified'],
      ])
      expect(report.criteria[1]!.unfound).toEqual([
        'The limit is 7 requests per second per tenant.',
      ])
    })

    it('states that nothing assessed the result when no assessor is wired', async () => {
      const { report } = await assessed(fakeAssessor(false))
      expect(report.state).toBe('unavailable')
      expect(report.criteria.every((c) => c.status === 'unverified')).toBe(true)
    })
  })
}
