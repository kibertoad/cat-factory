// Driving one task from `start` to a terminal state, answering what it parks on along the way.
//
// The loop is deliberately not "wait for terminal": a `pl_build` run parks on follow-up triage and
// a `pl_bugfix` run parks on its clarity gate, and a plain terminal wait would sit there until the
// budget expired and then report a stalled run. So it alternates (wait until something is
// answerable OR the run settles, answer it, wait again) with the run's OWN budget spanning the
// whole thing rather than resetting per park.
//
// The budget spanning the whole loop is the load-bearing detail. Per-wait budgets would let a run
// that parks repeatedly (a companion looping the coder) run indefinitely while every individual
// wait stayed inside its allowance, which is precisely the runaway an acceptance suite must not
// fund.

import type { CatFactoryClient, PublicRun } from '@cat-factory/sdk'
import { type AnsweredDecision, answerDecisions } from './decisions.ts'
import { formatDuration } from './deadline.ts'
import type { Journal } from './journal.ts'
import { describeRun, isTerminal, waitForDecisionOrSettled } from './publicApi.ts'

export type DriveOptions = {
  client: CatFactoryClient
  journal: Journal
  taskId: string
  pipelineId: string
  /** The steer handed to any question the run raises. See `AnswerOptions.steer`. */
  steer: string
  budgetMs: number
}

export type DriveResult = {
  run: PublicRun
  /** Every decision the suite answered, in order. Specs assert on this. */
  answered: AnsweredDecision[]
}

/**
 * Drive an already-started run to a terminal state.
 *
 * Starting is deliberately NOT this function's job: `resume.ts` owns whether a task is filed, a
 * live run re-attached to, or a finished one adopted, and folding a `start` in here is what made
 * an interrupted pass re-ship the same feature.
 */
export async function driveRun(options: DriveOptions & { runId: string }): Promise<DriveResult> {
  const { client, journal, taskId, runId, steer, budgetMs } = options
  const startedAt = Date.now()
  const answered: AnsweredDecision[] = []

  for (;;) {
    const remainingMs = budgetMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      const run = await client.tasks.getRun(taskId)
      throw new Error(
        `Run ${runId} spent its whole ${formatDuration(budgetMs)} budget across ` +
          `${answered.length} answered decision(s) without settling.\n` +
          `Last observed: ${describeRun(run)}`,
      )
    }

    const { run, decisions } = await waitForDecisionOrSettled({
      client,
      journal,
      taskId,
      runId,
      budgetMs: remainingMs,
    })
    if (isTerminal(run.status)) return { run, answered }

    // Reaching here means the run is asking for something. `answerDecisions` throws on any kind
    // this suite is not designed for, which is what stops the loop from driving a run past a
    // decision a person was meant to make.
    const justAnswered = await answerDecisions({ client, runId, steer }, decisions)
    for (const entry of justAnswered) {
      journal.say(
        'milestone',
        `answered '${entry.kind}': ${entry.actions.join('; ') || '(nothing pending)'}`,
      )
    }
    answered.push(...justAnswered)

    // A decision list whose every item was already settled would spin this loop against the
    // backend with nothing changing. Treat it as the stall it is rather than burning the budget.
    if (justAnswered.every((entry) => entry.actions.length === 0)) {
      throw new Error(
        `Run ${runId} reports ${decisions.decisions.length} decision(s) ` +
          `(${decisions.decisions.map((decision) => decision.kind).join(', ')}) but every item in ` +
          `them is already settled, so answering changes nothing and the run is not advancing.\n` +
          `Last observed: ${describeRun(run)}`,
      )
    }
  }
}

/**
 * Require a run to have finished successfully, with the failure spelled out when it did not.
 *
 * `done` is a strong claim on a pipeline carrying a `merger`: the platform reaches it only when
 * the pull request ACTUALLY merged, so this is also the assertion that the feature is on the
 * default branch for the next spec to file a bug against.
 */
export function requireRunDone(run: PublicRun, context: string): PublicRun {
  if (run.status === 'done') return run
  const failure = run.error ? `${run.error.code}: ${run.error.message}` : '(no error recorded)'
  const hint =
    run.status === 'blocked'
      ? `\n  The run is parked. Read GET /api/v1/runs/${run.runId}/decisions to see on what.`
      : run.pullRequest
        ? `\n  A pull request was opened (${run.pullRequest.url}) but the run did not reach 'done'. ` +
          `On a pipeline with a merger that means the merge was HELD rather than performed: check ` +
          `the workspace's merge-threshold preset, which this suite needs to permit auto-merge.`
        : ''
  throw new Error(`${context}: run ${run.runId} ended '${run.status}': ${failure}${hint}`)
}
