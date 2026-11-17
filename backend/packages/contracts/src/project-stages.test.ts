import { describe, expect, it } from 'vitest'
import { parseProjectDefinition } from './project-definitions.js'
import {
  deriveProjectStageStates,
  projectStageIssues,
  type ProjectStage,
  type ProjectStageTask,
} from './project-stages.js'

function stage(id: string, over: Partial<ProjectStage> = {}): ProjectStage {
  return {
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
  }
}

describe('projectStageIssues', () => {
  it('accepts a chain whose stages read only what they run after', () => {
    const stages = [
      stage('discover'),
      stage('decide', { after: ['discover'] }),
      stage('build', { after: ['decide'], consumes: [{ stage: 'discover' }, { stage: 'decide' }] }),
    ]
    expect(projectStageIssues(stages)).toEqual([])
  })

  it('names every structural problem', () => {
    const issues = projectStageIssues([
      stage('a', { after: ['ghost'] }),
      stage('b', { produces: 'a' }),
      stage('c', { consumes: [{ stage: 'a' }] }),
    ])
    expect(issues).toEqual([
      "stages 'a' and 'b' both produce the stream 'a'",
      "stage 'a' runs after unknown stage 'ghost'",
      "stage 'c' reads stage 'a', which it does not run after",
    ])
  })

  it('names a cycle instead of reading through it', () => {
    const issues = projectStageIssues([
      stage('a', { after: ['c'] }),
      stage('b', { after: ['a'] }),
      stage('c', { after: ['b'] }),
    ])
    expect(issues).toEqual(['stages run after each other in a cycle: a -> c -> b -> a'])
  })

  it('is applied by the definition envelope', () => {
    const parsed = parseProjectDefinition({
      kind: 'research',
      key: 'acme:vendor',
      version: 1,
      title: 'Vendor',
      stages: [stage('a'), stage('a', { produces: 'b' })],
      spec: {},
    })
    expect(parsed).toEqual({
      ok: false,
      issues: ["stage ids must be unique: 'a' repeats"],
    })
  })
})

describe('deriveProjectStageStates', () => {
  const stages = [stage('discover', { checkpoint: true }), stage('decide', { after: ['discover'] })]
  const task = (taskId: string, stageId: string, over: Partial<ProjectStageTask> = {}) => ({
    taskId,
    projectId: 'p1',
    stageId,
    createdAt: 1,
    recordedAt: null,
    clearedAt: null,
    clearedBy: null,
    ...over,
  })
  const outcome = (taskId: string, seq: number, stream: string) => ({
    id: `pout_${taskId}`,
    seq,
    stream,
    taskId,
  })
  const statuses = (input: Parameters<typeof deriveProjectStageStates>[0]) =>
    deriveProjectStageStates(input).map((s) => [s.stageId, s.status, s.stale])

  it('starts ready at the root and blocked behind it', () => {
    const states = deriveProjectStageStates({
      stages,
      stageTasks: [],
      liveTaskIds: new Set(),
      outcomes: [],
    })
    expect(states.map((s) => [s.stageId, s.status, s.waitingOn])).toEqual([
      ['discover', 'ready', []],
      ['decide', 'blocked', ['discover']],
    ])
  })

  it('runs a task, waits on the checkpoint, then unblocks the next stage once cleared', () => {
    const live = new Set(['t1'])
    expect(
      statuses({ stages, stageTasks: [task('t1', 'discover')], liveTaskIds: live, outcomes: [] }),
    ).toEqual([
      ['discover', 'in-progress', false],
      ['decide', 'blocked', false],
    ])
    const recorded = [outcome('t1', 1, 'discover')]
    expect(
      statuses({
        stages,
        stageTasks: [task('t1', 'discover')],
        liveTaskIds: live,
        outcomes: recorded,
      }),
    ).toEqual([
      ['discover', 'awaiting-checkpoint', false],
      ['decide', 'blocked', false],
    ])
    expect(
      statuses({
        stages,
        stageTasks: [task('t1', 'discover', { clearedAt: 5, clearedBy: 'u1' })],
        liveTaskIds: live,
        outcomes: recorded,
      }),
    ).toEqual([
      ['discover', 'done', false],
      ['decide', 'ready', false],
    ])
  })

  it('ignores a deleted task and an outcome written to the stream by no stage task', () => {
    const states = deriveProjectStageStates({
      stages,
      stageTasks: [task('gone', 'discover')],
      liveTaskIds: new Set(),
      outcomes: [outcome('stray', 1, 'discover')],
    })
    expect(states[0]).toMatchObject({ status: 'ready', activeTaskId: null, latest: null })
  })

  it('marks a downstream result stale once an upstream result newer than it is accepted', () => {
    const stageTasks = [
      task('t1', 'discover', { clearedAt: 2, clearedBy: null }),
      task('t2', 'decide'),
      task('t3', 'discover', { createdAt: 3, clearedAt: 4, clearedBy: null }),
    ]
    const states = deriveProjectStageStates({
      stages,
      stageTasks,
      liveTaskIds: new Set(['t1', 't2', 't3']),
      outcomes: [
        outcome('t1', 1, 'discover'),
        outcome('t2', 2, 'decide'),
        outcome('t3', 3, 'discover'),
      ],
    })
    expect(states.map((s) => [s.stageId, s.status, s.stale, s.accepted?.seq])).toEqual([
      ['discover', 'done', false, 3],
      ['decide', 'done', true, 2],
    ])
  })

  it('keeps the earlier accepted result while a newer one awaits the checkpoint', () => {
    const states = deriveProjectStageStates({
      stages,
      stageTasks: [
        task('t1', 'discover', { clearedAt: 2, clearedBy: null }),
        task('t3', 'discover'),
      ],
      liveTaskIds: new Set(['t1', 't3']),
      outcomes: [outcome('t1', 1, 'discover'), outcome('t3', 3, 'discover')],
    })
    expect(states[0]).toMatchObject({
      status: 'awaiting-checkpoint',
      latest: { seq: 3 },
      accepted: { seq: 1 },
    })
    expect(states[1]!.status).toBe('ready')
  })
})
