import type {
  FindingsRevisionBody,
  ProjectDefinition,
  ProjectStage,
  ProjectStageTask,
} from '@cat-factory/contracts'
import {
  type DecodedProjectOutcome,
  ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  researchKindModule,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { renderStagedProject } from './stagedProjectContext.js'

const config = (id: string, question: string) => ({
  brief: `Stage ${id}.`,
  topics: [{ id: 'main', title: 'Main', questions: [{ id, question }] }],
})

const stage = (id: string, question: string, over: Partial<ProjectStage> = {}): ProjectStage => ({
  id,
  title: id,
  taskType: 'research',
  after: [],
  consumes: [],
  produces: id,
  start: 'manual',
  checkpoint: false,
  repeatable: false,
  config: config(id, question),
  ...over,
})

const definition: ProjectDefinition = {
  kind: 'research',
  key: 'acme:staged',
  version: 1,
  title: 'Staged',
  credentials: [],
  targets: [],
  inputs: [],
  promptAdditions: {},
  stages: [
    stage('discover', 'Which scheme?'),
    stage('deepen', 'How paging?', { after: ['discover'] }),
  ],
  spec: {},
}

const findings = (questionId: string): FindingsRevisionBody => ({
  summary: `Found ${questionId}.`,
  learnings: [],
  adhocQuestions: [],
  findings: [
    {
      questionId,
      status: 'answered',
      answer: `${questionId} known`,
      confidence: 'high',
      evidence: [],
      caveats: [],
    },
  ],
})

function row(
  id: string,
  seq: number,
  stream: string,
  taskId: string,
  intent = 'initial',
): ProjectOutcomeRow {
  return {
    id,
    projectId: 'prj_1',
    stream,
    seq,
    intent,
    schemaVersion: 1,
    taskId,
    taskType: 'research',
    definitionKey: 'acme:staged',
    definitionVersion: 1,
    artifactRefs: [],
    createdAt: seq,
    body: { kind: 'inline', json: '{}' },
    bodyBytes: 2,
  }
}

const record = (taskId: string, stageId: string): ProjectStageTask => ({
  taskId,
  projectId: 'prj_1',
  stageId,
  createdAt: 1,
  basis: {},
  recordedAt: 2,
  clearedAt: null,
  clearedBy: null,
  acceptedOutcomeId: null,
})

describe('renderStagedProject', () => {
  it("renders each stage's accepted result through its handler, and states one with none", () => {
    const modules = new ProjectKindModuleRegistry()
    modules.register(researchKindModule)
    const envelopes = [row('pout_t1', 1, 'discover', 't1')]
    const decoded = new Map<string, DecodedProjectOutcome>([
      ['pout_t1', { ...envelopes[0]!, taskType: 'research', body: findings('discover') }],
    ])
    const { rendering, revision } = renderStagedProject({
      modules,
      kind: 'research',
      definition,
      inputs: {},
      records: [record('t1', 'discover')],
      envelopes,
      decoded,
    })
    expect(rendering.summary).toBe('1 of 2 stage(s) have an accepted result.')
    expect(rendering.body).toContain('## Stage discover')
    expect(rendering.body).toContain('discover known')
    expect(rendering.body).toContain('## Stage deepen\n\nNo accepted result yet.')
    expect(rendering.coverage).toContain('deepen: no accepted result')
    expect(revision).toEqual({ id: 'pout_t1', seq: 1 })
  })
})
