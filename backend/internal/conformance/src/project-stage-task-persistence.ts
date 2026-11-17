import { expect, it } from 'vitest'
import type { ProjectOutcomePersistenceRepos } from './project-outcome-persistence-suite.js'

// The stage-task records a staged project keeps: which stage each task runs, the one open task a
// stage may have at a time (a claim two concurrent starts race on), the outcome that frees it, and
// a person accepting that outcome at the stage's checkpoint. Runs inside the outcome persistence
// suite on every store.

/** A stage-task record with no outcome and no acceptance yet. */
export function stageTaskRecord(projectId: string, taskId: string, stageId: string, createdAt = 1) {
  return {
    taskId,
    projectId,
    stageId,
    createdAt,
    basis: {},
    recordedAt: null,
    clearedAt: null,
    clearedBy: null,
  }
}

export function defineStageTaskPersistence(
  makeRepos: () => ProjectOutcomePersistenceRepos,
  unique: (prefix: string) => string,
): void {
  it('lets exactly one of several concurrent tasks claim a stage until it records', async () => {
    const repos = makeRepos()
    const projectId = unique('prj')
    const tasks = [unique('task'), unique('task'), unique('task')]
    const claims = await Promise.all(
      tasks.map((taskId, i) =>
        repos.records.insertStageTask(stageTaskRecord(projectId, taskId, 'discover', i)),
      ),
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    const winner = tasks[claims.indexOf(true)]!
    // Another stage of the same project has its own slot, and a replayed bind is refused.
    expect(
      await repos.records.insertStageTask(stageTaskRecord(projectId, unique('task'), 'decide')),
    ).toBe(true)
    expect(
      await repos.records.insertStageTask(stageTaskRecord(projectId, winner, 'discover')),
    ).toBe(false)

    await repos.records.markStageTaskRecorded(projectId, winner, 50)
    await repos.records.markStageTaskRecorded(projectId, winner, 60)
    const next = unique('task')
    expect(
      await repos.records.insertStageTask(stageTaskRecord(projectId, next, 'discover', 9)),
    ).toBe(true)
    const listed = await repos.records.listStageTasks(projectId)
    expect(
      listed.filter((t) => t.stageId === 'discover').map((t) => [t.taskId, t.recordedAt]),
    ).toEqual([
      [winner, 50],
      [next, null],
    ])
  })

  it('clears a checkpoint once, only on a recorded task, and frees a deleted task', async () => {
    const repos = makeRepos()
    const projectId = unique('prj')
    const [recorded, open] = [unique('task'), unique('task')]
    const basis = { scout: 'pout_scout', map: null }
    await repos.records.insertStageTask({
      ...stageTaskRecord(projectId, recorded, 'discover'),
      basis,
    })
    await repos.records.markStageTaskRecorded(projectId, recorded, 5)
    await repos.records.insertStageTask(stageTaskRecord(projectId, open, 'discover', 2))
    expect(await repos.records.clearStageCheckpoint(projectId, open, 7, 'usr_1')).toBe(false)
    expect(await repos.records.clearStageCheckpoint('prj_other', recorded, 7, 'usr_1')).toBe(false)
    expect(await repos.records.clearStageCheckpoint(projectId, recorded, 7, 'usr_1')).toBe(true)
    expect(await repos.records.clearStageCheckpoint(projectId, recorded, 8, null)).toBe(false)
    expect((await repos.records.listStageTasks(projectId))[0]).toEqual({
      ...stageTaskRecord(projectId, recorded, 'discover'),
      basis,
      recordedAt: 5,
      clearedAt: 7,
      clearedBy: 'usr_1',
    })
    await repos.records.deleteStageTasks(projectId, [open])
    await repos.records.deleteStageTasks(projectId, [])
    expect((await repos.records.listStageTasks(projectId)).map((t) => t.taskId)).toEqual([recorded])
    expect(
      await repos.records.insertStageTask(
        stageTaskRecord(projectId, unique('task'), 'discover', 3),
      ),
    ).toBe(true)
  })
}
