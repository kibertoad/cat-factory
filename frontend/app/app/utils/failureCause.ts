// ---------------------------------------------------------------------------
// What a failed run tells the person who looks at it: one translated cause line and the one
// action that most probably fixes it.
//
// The backend sends its own English `hint` for each failure kind. That text explains the
// runtime to the person who operates the deployment, so the SPA shows it only behind the
// failure block's Details toggle. The cause line here is the SPA's own copy, keyed by the
// machine-readable `kind` and `reason`, so it is translated and it says if a retry will
// probably work.
//
// `FAILURE_CAUSE_KEYS` is an exhaustive `Record<AgentFailureKind, …>`, so a kind added to the
// contract fails the typecheck here instead of showing no cause. A kind that a release retired
// can still arrive on a stored run, so the lookup narrows through `isAgentFailureKind` and names
// such a kind as `unknown`.
// ---------------------------------------------------------------------------

import { isAgentFailureKind } from '@cat-factory/contracts'
import type { ConflictReason, EnvironmentFailureReason } from '@cat-factory/contracts'
import type { AgentFailure, AgentFailureKind } from '~/types/execution'
import type { AgentRunSummary } from '~/stores/agentRuns'

/** i18n key of the one-line cause, per failure kind, for a task run. */
export const FAILURE_CAUSE_KEYS: Record<AgentFailureKind, string> = {
  preflight: 'board.failure.cause.preflight',
  dispatch: 'board.failure.cause.dispatch',
  environment: 'board.failure.cause.environment',
  evicted: 'board.failure.cause.evicted',
  harness_shutdown: 'board.failure.cause.harness_shutdown',
  timeout: 'board.failure.cause.timeout',
  agent: 'board.failure.cause.agent',
  job_failed: 'board.failure.cause.job_failed',
  delegated_failed: 'board.failure.cause.delegated_failed',
  rejected: 'board.failure.cause.rejected',
  companion_rejected: 'board.failure.cause.companion_rejected',
  stalled: 'board.failure.cause.stalled',
  state_unreadable: 'board.failure.cause.state_unreadable',
  cancelled: 'board.failure.cause.cancelled',
  unknown: 'board.failure.cause.unknown',
}

/**
 * The kinds whose meaning is different for a single-job run (a service bootstrap, an environment
 * config repair). Such a run is one job with no steps and no automatic restarts: an eviction is
 * one loss, its watchdog also fires on inactivity, and its `agent` failure can be the git push.
 * The other kinds read the same for every run.
 */
const SINGLE_JOB_CAUSE_KEYS: Partial<Record<AgentFailureKind, string>> = {
  evicted: 'board.failure.cause.singleJob.evicted',
  timeout: 'board.failure.cause.singleJob.timeout',
  agent: 'board.failure.cause.singleJob.agent',
}

const GITHUB_NOT_CONNECTED: ConflictReason = 'github_not_connected'
const DEPLOY_RUNNER_UNWIRED: EnvironmentFailureReason = 'deploy_runner_unwired'

/** Which run failed: a task run (`execution`) or a single-job run. */
export type FailureRunKind = AgentRunSummary['kind']

/**
 * The one action the failure block offers.
 *
 * - `retry`: run the work again. Most causes are temporary or are fixed in the run itself.
 * - `connectRepoHost`: the run did not start because no repository host is connected. A retry
 *   fails again until it is connected, so the block opens the connection instead.
 * - `environmentSetup` / `runnerPoolSetup`: the test environment could not be made. The fix is
 *   a setting, so the block opens the settings tab for that cause.
 * - `newRun`: the run's saved state cannot be read, so a retry reads the same broken state. The
 *   block starts the task again as a new run.
 *
 * For every action other than `retry`, Retry stays available inside the Details toggle.
 */
export type FailureAction =
  | 'retry'
  | 'connectRepoHost'
  | 'environmentSetup'
  | 'runnerPoolSetup'
  | 'newRun'

/** The cause line and the action for one failure. */
export interface FailurePresentation {
  causeKey: string
  action: FailureAction
}

/** What decides the cause line and the action, besides the failure itself. */
export interface FailureContext {
  runKind: FailureRunKind
  /**
   * A local node. There a `deploy_runner_unwired` cause is fixed by an environment variable,
   * not by a settings tab, so it gets its own cause line and Retry.
   */
  localMode: boolean
}

/** The i18n key of a failure's one-line cause. */
export function failureCauseKey(
  failure: Pick<AgentFailure, 'kind' | 'reason'>,
  context: FailureContext,
): string {
  if (failure.reason === GITHUB_NOT_CONNECTED) {
    return 'errors.conflict.description.github_not_connected'
  }
  if (isLocalDeployRunnerUnwired(failure, context)) {
    return 'board.failure.cause.deployRunnerUnwiredLocal'
  }
  const kind: AgentFailureKind = isAgentFailureKind(failure.kind) ? failure.kind : 'unknown'
  const singleJobKey = context.runKind === 'execution' ? undefined : SINGLE_JOB_CAUSE_KEYS[kind]
  return singleJobKey ?? FAILURE_CAUSE_KEYS[kind]
}

/** The cause line and the action for a failure. */
export function presentFailure(
  failure: Pick<AgentFailure, 'kind' | 'reason'>,
  context: FailureContext,
): FailurePresentation {
  const causeKey = failureCauseKey(failure, context)
  return { causeKey, action: failureAction(failure, context) }
}

function failureAction(
  failure: Pick<AgentFailure, 'kind' | 'reason'>,
  context: FailureContext,
): FailureAction {
  if (failure.reason === GITHUB_NOT_CONNECTED) return 'connectRepoHost'
  if (failure.kind === 'state_unreadable' && context.runKind === 'execution') return 'newRun'
  if (failure.kind !== 'environment') return 'retry'
  if (failure.reason !== DEPLOY_RUNNER_UNWIRED) return 'environmentSetup'
  // On a local node the fix is a variable in `.env`; after it is set, Retry is the next step.
  return context.localMode ? 'retry' : 'runnerPoolSetup'
}

function isLocalDeployRunnerUnwired(
  failure: Pick<AgentFailure, 'kind' | 'reason'>,
  context: FailureContext,
): boolean {
  return (
    context.localMode && failure.kind === 'environment' && failure.reason === DEPLOY_RUNNER_UNWIRED
  )
}
