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
import { type AnsweredDecision, answerDecisions } from './decisions.js'
import { formatDuration } from './deadline.js'
import type { Journal } from './journal.js'
import {
  type CredentialRetry,
  describeDecisions,
  describeRun,
  isTerminal,
  passThroughCredentialRetry,
  waitForDecisionOrSettled,
} from './client.js'

export type DriveOptions = {
  client: CatFactoryClient
  journal: Journal
  taskId: string
  pipelineId: string
  /** The steer handed to any question the run raises. See `AnswerOptions.steer`. */
  steer: string
  budgetMs: number
  /**
   * How a write that may be refused for want of a PER-USER credential is retried. Absent ⇒ the call
   * is made once, which is right for a workspace whose models are all reached with the deployment's
   * own keys.
   *
   * Needed HERE and not only at the start, because answering a park wakes the durable driver and the
   * deployment re-mints the run's credential activation on that call: a resumed pass that only ever
   * re-attaches to a live run and answers its gates never touches `start`, so this is the only place
   * it would be asked.
   */
  credentials?: CredentialRetry
  /**
   * The suite's own "nothing was cleaned up" tail (`leftInPlaceNote`), printed under a wait that
   * expires. Absent ⇒ the expiry states what it observed and offers no resume, which is the honest
   * answer for a suite that has not declared how one is resumed.
   */
  epilogue?: string
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
  const credentials = options.credentials ?? passThroughCredentialRetry
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
      ...(options.epilogue === undefined ? {} : { epilogue: options.epilogue }),
    })
    if (isTerminal(run.status)) return { run, answered }

    // Reaching here means the run is asking for something ANSWERABLE: the wait returns on
    // `isActionable`, so a decision the driver still owns leaves this loop sleeping rather than
    // pushing writes at it. `answerDecisions` throws on any kind this suite is not designed for,
    // which is what stops the loop from driving a run past a decision a person was meant to make.
    const justAnswered = await credentials(`Answering run ${runId}`, () =>
      answerDecisions({ client, runId, steer }, decisions),
    )
    for (const entry of justAnswered) {
      journal.say(
        'milestone',
        `answered '${entry.kind}': ${entry.actions.join('; ') || '(nothing pending)'}`,
      )
    }
    answered.push(...justAnswered)

    // The wait promised something actionable and answering it produced nothing, so the predicate
    // the wait used and the answer path disagree. Refusing here is what keeps that a loud bug
    // rather than this loop spinning against the deployment until the budget runs out.
    // `every` over nothing is `true`, which is the case where the wait promised an actionable
    // decision and the filter kept none: the same disagreement, and it lands in the same message.
    if (justAnswered.every((entry) => entry.actions.length === 0)) {
      throw new Error(
        `Run ${runId} was reported as having an answerable decision among ` +
          `${decisions.decisions.length} listed (${describeDecisions(decisions)}), but answering ` +
          `took no action, so the run is not advancing.\n` +
          `That is a disagreement between isActionable() and the answering path in the kit's ` +
          `decision module rather than a problem with the run.\n` +
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
 * default branch for the next scenario to file a bug against.
 */
export function requireRunDone(run: PublicRun, context: string): PublicRun {
  if (run.status === 'done') return run
  const failure = run.error ? `${run.error.code}: ${run.error.message}` : '(no error recorded)'
  throw new Error(`${context}: run ${run.runId} ended '${run.status}': ${failure}${hintFor(run)}`)
}

/**
 * The line under a run that did not finish, saying where to look next.
 *
 * ORDER IS THE POINT, and it took a wasted investigation to get right. A run that FAILED has
 * already said why, in its own error, and any hint offered on top of that competes with it: the
 * merge-preset line below fires on "there is a pull request and the status is not done", which is
 * also true of a run that died in the coder step three phases before any merge was considered. It
 * sent the reader to a threshold setting to explain a container that had been killed.
 *
 * So a failure keeps the floor, a park says where the decision list is, and the merge hint is
 * offered only where nothing else explains the stop: the run finished its pipeline, opened a pull
 * request, and still is not `done`.
 */
function hintFor(run: PublicRun): string {
  if (run.error) {
    return (
      `\n  The run FAILED rather than being held: the error above is the deployment's own account ` +
      `of it. GET /api/v1/debug/runs/${run.runId} carries the step it died on and that step's ` +
      `failure detail.`
    )
  }
  if (run.status === 'blocked') {
    return `\n  The run is parked. Read GET /api/v1/runs/${run.runId}/decisions to see on what.`
  }
  if (run.pullRequest) {
    return (
      `\n  A pull request was opened (${run.pullRequest.url}) and the run recorded no failure, so ` +
      `on a pipeline with a merger the merge was HELD rather than performed: check the ` +
      `workspace's merge-threshold preset, which this suite needs to permit auto-merge.`
    )
  }
  return ''
}
