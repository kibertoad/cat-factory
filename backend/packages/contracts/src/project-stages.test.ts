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
    writes: false,
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

  it('refuses a stage reading one upstream stage twice', () => {
    expect(
      projectStageIssues([
        stage('a'),
        stage('b', { after: ['a'], consumes: [{ stage: 'a' }, { stage: 'a' }] }),
      ]),
    ).toEqual(["stage 'b' reads stage 'a' more than once"])
  })

  it('names a cycle instead of reading through it', () => {
    const issues = projectStageIssues([
      stage('a', { after: ['c'] }),
      stage('b', { after: ['a'] }),
      stage('c', { after: ['b'] }),
    ])
    expect(issues).toEqual(['stages run after each other in a cycle: a -> c -> b -> a'])
  })

  it('lets a stage write only after a stage a person accepts at a checkpoint', () => {
    expect(
      projectStageIssues([
        stage('plan', { checkpoint: true }),
        stage('apply', { after: ['plan'], writes: true }),
      ]),
    ).toEqual([])
    expect(
      projectStageIssues([stage('plan'), stage('apply', { after: ['plan'], writes: true })]),
    ).toEqual([
      "stage 'apply' writes, so it must run after a stage a person accepts at a checkpoint",
    ])
  })

  it('refuses a writing stage in a definition whose targets allow no writes', () => {
    const definition = (access?: 'write') => ({
      kind: 'research',
      key: 'acme:vendor',
      version: 1,
      title: 'Vendor',
      targets: [
        { baseUrl: 'https://api.vendor.example', surface: 'api', ...(access ? { access } : {}) },
      ],
      stages: [
        stage('plan', { checkpoint: true }),
        stage('apply', { after: ['plan'], writes: true }),
      ],
      spec: {},
    })
    expect(parseProjectDefinition(definition())).toEqual({
      ok: false,
      issues: ["stage 'apply' writes, but no target allows writes"],
    })
    expect(parseProjectDefinition(definition('write')).ok).toBe(true)
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
    basis: {},
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

  it('ignores a deleted task with no result and an outcome no stage task wrote', () => {
    const states = deriveProjectStageStates({
      stages,
      stageTasks: [task('gone', 'discover')],
      liveTaskIds: new Set(),
      outcomes: [outcome('stray', 1, 'discover')],
    })
    expect(states[0]).toMatchObject({ status: 'ready', activeTaskId: null, latest: null })
  })

  it('marks a downstream result stale once its upstream accepts a result it did not start from', () => {
    const outcomes = [
      outcome('a', 5, 'discover'),
      outcome('b', 6, 'discover'),
      outcome('d', 7, 'decide'),
    ]
    const live = new Set(['a', 'b', 'd'])
    const stageTasks = (bAccepted: boolean) => [
      task('a', 'discover', { clearedAt: 1 }),
      task('b', 'discover', { createdAt: 2, clearedAt: bAccepted ? 9 : null }),
      // Started while `a` was discover's accepted result, recorded after `b` was.
      task('d', 'decide', { createdAt: 3, basis: { discover: 'pout_a' } }),
    ]
    const decide = (bAccepted: boolean) =>
      deriveProjectStageStates({
        stages,
        stageTasks: stageTasks(bAccepted),
        liveTaskIds: live,
        outcomes,
      })[1]!
    expect(decide(false)).toMatchObject({ status: 'done', stale: false })
    expect(decide(true)).toMatchObject({ status: 'done', stale: true })
  })

  it("still counts a deleted task's recorded result, and only stops counting it as running", () => {
    const states = deriveProjectStageStates({
      stages,
      stageTasks: [
        task('t1', 'discover', { clearedAt: 2 }),
        task('t2', 'discover', { createdAt: 3 }),
      ],
      liveTaskIds: new Set(),
      outcomes: [outcome('t1', 1, 'discover')],
    })
    expect(states.map((s) => [s.stageId, s.status, s.activeTaskId, s.accepted?.seq])).toEqual([
      ['discover', 'done', null, 1],
      ['decide', 'ready', null, undefined],
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
