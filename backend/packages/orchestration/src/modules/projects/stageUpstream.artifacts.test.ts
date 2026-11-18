import type { ProjectDefinition, ProjectStage, ProjectStageTask } from '@cat-factory/contracts'
import type { ProjectOutcomeRow } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { upstreamArtifactRefs } from './stageUpstream.js'

// The artifacts a task may reference are those the results it reads held when it started: the
// same rows the upstream rendering reads, so the allow-list is what the agent was shown.

const stage = (id: string, over: Partial<ProjectStage> = {}): ProjectStage => ({
  id,
  title: id,
  taskType: 'research',
  after: [],
  consumes: [],
  produces: id,
  start: 'manual',
  checkpoint: false,
  repeatable: false,
  ...over,
})

const definition = {
  stages: [
    stage('discover'),
    stage('handoff', {
      taskType: 'writeup',
      after: ['discover'],
      consumes: [{ stage: 'discover' }],
    }),
  ],
} as unknown as ProjectDefinition

const record = (taskId: string, stageId: string, basis: Record<string, string | null> = {}) =>
  ({
    taskId,
    projectId: 'prj_1',
    stageId,
    createdAt: 1,
    basis,
    recordedAt: 2,
    clearedAt: null,
    clearedBy: null,
    acceptedOutcomeId: null,
  }) satisfies ProjectStageTask

const row = (id: string, seq: number, taskId: string, artifactRefs: string[]) =>
  ({
    id,
    projectId: 'prj_1',
    stream: 'discover',
    seq,
    intent: 'initial',
    taskId,
    artifactRefs,
  }) as unknown as ProjectOutcomeRow

describe('upstreamArtifactRefs', () => {
  it('holds the artifacts of the results the task started from, and no later one', () => {
    const own = record('t_write', 'handoff', { discover: 'pout_a' })
    const records = [record('t_a', 'discover'), record('t_b', 'discover'), own]
    const envelopes = [
      row('pout_a', 1, 't_a', ['art_shot', 'art_shot']),
      row('pout_b', 2, 't_b', ['art_later']),
    ]
    expect(
      upstreamArtifactRefs(
        definition,
        { stage: definition.stages[1]!, record: own, records },
        envelopes,
      ),
    ).toEqual(['art_shot'])
  })

  it('refuses when a result the task started from is gone, as the rendering does', () => {
    const own = record('t_write', 'handoff', { discover: 'pout_gone' })
    expect(() =>
      upstreamArtifactRefs(
        definition,
        { stage: definition.stages[1]!, record: own, records: [own] },
        [],
      ),
    ).toThrow(/cannot be read/)
  })
})
