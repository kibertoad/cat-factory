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
import { demoteHeadings } from './stageRendering.js'
import { hasStagedResult, renderStagedProject, selectStagedResult } from './stagedProjectContext.js'

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

const record = (
  taskId: string,
  stageId: string,
  over: Partial<ProjectStageTask> = {},
): ProjectStageTask => ({
  taskId,
  projectId: 'prj_1',
  stageId,
  createdAt: 1,
  basis: {},
  recordedAt: 2,
  clearedAt: null,
  clearedBy: null,
  acceptedOutcomeId: null,
  ...over,
})

function render(
  def: ProjectDefinition,
  records: ProjectStageTask[],
  envelopes: ProjectOutcomeRow[],
  bodies: Record<string, FindingsRevisionBody>,
) {
  const modules = new ProjectKindModuleRegistry()
  modules.register(researchKindModule)
  const selection = selectStagedResult(def, records, envelopes)
  const decoded = new Map<string, DecodedProjectOutcome>(
    envelopes.map((e) => [e.id, { ...e, taskType: 'research', body: bodies[e.id] }]),
  )
  return {
    selection,
    ...renderStagedProject({
      modules,
      kind: 'research',
      definition: def,
      inputs: {},
      selection,
      decoded,
    }),
  }
}

describe('renderStagedProject', () => {
  it("renders each stage's accepted result through its handler, and states one with none", () => {
    const { rendering, revision, selection } = render(
      definition,
      [record('t1', 'discover')],
      [row('pout_t1', 1, 'discover', 't1')],
      { pout_t1: findings('discover') },
    )
    expect(hasStagedResult(selection)).toBe(true)
    expect(rendering.summary).toBe('1 of 2 stage(s) have an accepted result.')
    expect(rendering.body).toContain('## Stage discover')
    expect(rendering.body).toContain('discover known')
    expect(rendering.body).toContain('## Stage deepen\n\nNo accepted result yet.')
    expect(rendering.coverage).toContain('deepen: no accepted result')
    expect(revision).toEqual({ id: 'pout_t1', seq: 1 })
  })

  it('reads nothing of a result still awaiting its checkpoint', () => {
    const gated = {
      ...definition,
      stages: [stage('discover', 'Which scheme?', { checkpoint: true })],
    }
    const { rendering, revision, selection } = render(
      gated,
      [record('t1', 'discover')],
      [row('pout_t1', 1, 'discover', 't1')],
      { pout_t1: findings('discover') },
    )
    expect(hasStagedResult(selection)).toBe(false)
    expect(selection.stages[0]!.rows).toEqual([])
    expect(rendering.body).not.toContain('discover known')
    expect(revision).toBeNull()
  })

  it('leaves out a revision no acceptance named, and names every accepted stage in the revision', () => {
    const gated = {
      ...definition,
      stages: [
        stage('discover', 'Which scheme?', { checkpoint: true }),
        stage('deepen', 'How paging?', { after: ['discover'] }),
      ],
    }
    const { rendering, revision } = render(
      gated,
      [
        record('t1', 'discover', { clearedAt: 3, clearedBy: 'usr', acceptedOutcomeId: 'pout_r1' }),
        record('t2', 'deepen'),
      ],
      [
        row('pout_t1', 1, 'discover', 't1'),
        row('pout_r1', 2, 'discover', 't1', 'revise'),
        row('pout_d1', 3, 'deepen', 't2'),
        row('pout_r2', 4, 'discover', 't1', 'revise'),
      ],
      {
        pout_t1: findings('discover'),
        pout_r1: findings('discover'),
        pout_d1: findings('deepen'),
        pout_r2: { ...findings('discover'), summary: 'Unaccepted revision.' },
      },
    )
    expect(rendering.body).not.toContain('Unaccepted revision.')
    expect(revision).toEqual({ id: 'pout_r1+pout_d1', seq: 3 })
  })
})

describe('demoteHeadings', () => {
  it('nests every heading one level deeper, leaving fenced lines alone', () => {
    expect(demoteHeadings('# A\n## B\n```\n# not a heading\n```\ntext')).toBe(
      '## A\n### B\n```\n# not a heading\n```\ntext',
    )
  })
})
