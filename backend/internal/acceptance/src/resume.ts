// RESUMING a spec that files work: adopt what a previous pass started, rather than filing it again.
//
// The ledger has always remembered what a pass created, and spec 01 has always re-read the board
// before bootstrapping. The specs that FILE WORK did not: each one created a task and started a
// run unconditionally, so a pass interrupted forty minutes into `pl_build` re-filed the same
// feature on the next attempt. That is the most expensive failure this suite can have. It spends
// the whole run again, and it does something worse than waste money: two runs against one
// repository's default branch race on the same branch, which is the exact collision the platform's
// own task-dependency edges exist to prevent.
//
// So a run is recorded at THREE points and re-read at all three: the task id the moment it is
// created, the run id the moment `start` returns it, and the pull request when the run settles.
// Recording the run id after the drive (the shape this replaced) leaves the one window that
// matters uncovered, because the window IS the drive.
//
// **What resuming never does is assume.** Every adoption re-reads the deployment: a ledger naming
// a task the board no longer holds files a fresh one and says so, and a run that is still working
// is re-attached to rather than restarted.

import { type CatFactoryClient, CatFactoryNotFoundError, type PublicRun } from '@cat-factory/sdk'
import type { Journal } from './journal.ts'
import { type DriveResult, driveRun } from './runDriver.ts'
import { describeRun, isTerminal } from './publicApi.ts'
import type { RunRecord } from './world.ts'

export type FileAndDriveOptions = {
  client: CatFactoryClient
  journal: Journal
  /** What a previous pass recorded for this piece of work, if anything. */
  existing: RunRecord | null
  /** File the task. Called only when there is nothing to adopt. */
  createTask: () => Promise<{ taskId: string }>
  pipelineId: string
  steer: string
  budgetMs: number
  /**
   * Persist a record. Called at every point the record changes, and expected to write through
   * to the ledger synchronously: this callback is the only thing standing between an interrupted
   * run and an orphaned pull request nobody can find.
   */
  onRecord: (record: RunRecord) => void
  /** Human label for the work, used in every message. */
  label: string
}

export type FileAndDriveResult = DriveResult & {
  record: RunRecord
  /**
   * Every decision kind answered on this run, INCLUDING those a previous attempt answered.
   *
   * The claim spec 03 makes is "this suite answered a human gate over the public API", and that
   * claim is not weakened by the answering having happened before the process restarted. Reading
   * it off `answered` alone would report a resumed pass as never having exercised the gate.
   */
  answeredKinds: readonly string[]
}

/**
 * File a task (or adopt the one already filed), drive it to terminal, and record it throughout.
 *
 * The four states a resumed pass can find, each needing a different action:
 *
 *   1. **Nothing recorded.** File it, record, start, record, drive.
 *   2. **A task recorded, but the board has no such task.** Someone deleted it, or it was filed
 *      against a board that has since been reset. File it again, saying so.
 *   3. **A task recorded whose run already reached a terminal state.** Adopt it: the work is
 *      done, and re-running it would spend an afternoon to reach the state already in hand.
 *   4. **A task recorded whose run is still live.** Re-attach and keep driving it under a fresh
 *      budget. This is the case the whole module exists for.
 */
export async function fileAndDrive(options: FileAndDriveOptions): Promise<FileAndDriveResult> {
  const { journal, existing, label, onRecord } = options

  const adopted: Adoption = existing?.taskId ? await adopt(options, existing) : { kind: 'gone' }
  // Carried only onto work the ledger's own task still names. On the `gone` path the recorded task
  // is being re-filed, and its predecessor's gate answers are a fact about a run the board no
  // longer has: inheriting them would let spec 03 claim it drove the clarity gate on a run that
  // never reached it, which is the one claim the ledger carries this set to make.
  const carried = adopted.kind === 'gone' ? [] : (existing?.answeredKinds ?? [])
  if (adopted.kind === 'settled') {
    journal.say(
      'milestone',
      `adopting the already-finished '${label}' from a previous pass: ${describeRun(adopted.run)}`,
    )
    const record = recordOf(adopted.run, adopted.taskId, carried)
    onRecord(record)
    return { run: adopted.run, answered: [], record, answeredKinds: carried }
  }

  const taskId = adopted.kind === 'gone' ? await fileTask(options) : adopted.taskId
  const live = adopted.kind === 'live' ? adopted.run : null
  const runId = live?.runId ?? (await startRun(options, taskId))
  onRecord({
    taskId,
    runId,
    pullRequestUrl: live?.pullRequest?.url ?? null,
    answeredKinds: carried,
  })

  const result = await driveRun({ ...options, taskId, runId })
  const answeredKinds = [...new Set([...carried, ...result.answered.map((entry) => entry.kind)])]
  const record = recordOf(result.run, taskId, answeredKinds)
  onRecord(record)
  return { ...result, record, answeredKinds }
}

/**
 * What the deployment still holds for a recorded task: the four states in the doc above, as a
 * union rather than a nullable pair, so a caller cannot read a run off a state that has none.
 */
type Adoption =
  | { kind: 'settled'; taskId: string; run: PublicRun }
  | { kind: 'live'; taskId: string; run: PublicRun }
  | { kind: 'unstarted'; taskId: string }
  | { kind: 'gone' }

async function adopt(options: FileAndDriveOptions, existing: RunRecord): Promise<Adoption> {
  const { client, journal, label } = options
  let run: PublicRun
  try {
    run = await client.tasks.getRun(existing.taskId)
  } catch (error) {
    if (!(error instanceof CatFactoryNotFoundError)) throw error
    // A 404 covers both "no such task" and "a task with no run", which need opposite actions, so
    // the distinction is settled by asking for the task itself. Filing a duplicate merely because
    // a run had not started yet would be the same expensive mistake in a smaller window.
    if (!(await taskExists(client, existing.taskId))) {
      journal.record(
        'milestone',
        `the ledger names task ${existing.taskId} for '${label}' but the board no longer has ` +
          `it; filing again`,
      )
      return { kind: 'gone' }
    }
    journal.record(
      'milestone',
      `re-starting '${label}': task ${existing.taskId} was filed but never ran`,
    )
    return { kind: 'unstarted', taskId: existing.taskId }
  }

  if (isTerminal(run.status)) return { kind: 'settled', taskId: existing.taskId, run }
  journal.say('milestone', `re-attaching to the live run for '${label}': ${describeRun(run)}`)
  return { kind: 'live', taskId: existing.taskId, run }
}

async function taskExists(client: CatFactoryClient, taskId: string): Promise<boolean> {
  try {
    await client.tasks.get(taskId)
    return true
  } catch (error) {
    if (error instanceof CatFactoryNotFoundError) return false
    throw error
  }
}

async function fileTask(options: FileAndDriveOptions): Promise<string> {
  const { createTask, journal, label, onRecord } = options
  const { taskId } = await createTask()
  // Recorded BEFORE anything is started: a process killed between the create and the start would
  // otherwise leave a task on the board that no ledger names and no resume can find.
  onRecord({ taskId, runId: null, pullRequestUrl: null, answeredKinds: [] })
  journal.say('milestone', `filed '${label}' as ${taskId}`)
  return taskId
}

async function startRun(options: FileAndDriveOptions, taskId: string): Promise<string> {
  const { client, journal, pipelineId, label } = options
  const task = await client.tasks.start(taskId, { pipelineId })
  if (!task.runId) {
    throw new Error(
      `Starting '${label}' (task ${taskId}) on '${pipelineId}' returned no runId, so there is ` +
        `nothing to follow.`,
    )
  }
  journal.say('milestone', `started '${label}' on ${pipelineId} → run ${task.runId}`)
  return task.runId
}

function recordOf(run: PublicRun, taskId: string, answeredKinds: readonly string[]): RunRecord {
  return {
    taskId,
    runId: run.runId,
    pullRequestUrl: run.pullRequest?.url ?? null,
    answeredKinds,
  }
}
