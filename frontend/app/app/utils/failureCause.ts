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
// contract fails the typecheck here instead of showing no cause.
// ---------------------------------------------------------------------------

import type { ConflictReason, EnvironmentFailureReason } from '@cat-factory/contracts'
import type { AgentFailure, AgentFailureKind } from '~/types/execution'

/** i18n key of the one-line cause, per failure kind. */
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

const GITHUB_NOT_CONNECTED: ConflictReason = 'github_not_connected'
const DEPLOY_RUNNER_UNWIRED: EnvironmentFailureReason = 'deploy_runner_unwired'

/**
 * The one action the failure block offers.
 *
 * - `retry`: run the work again. Most causes are temporary or are fixed in the run itself.
 * - `connectRepoHost`: the run did not start because no repository host is connected. A retry
 *   fails again until it is connected, so the block opens the connection instead.
 * - `environmentSetup` / `runnerPoolSetup`: the test environment could not be made. The fix is
 *   a setting, so the block opens the settings tab for that cause.
 *
 * For every action other than `retry`, Retry stays available inside the Details toggle.
 */
export type FailureAction = 'retry' | 'connectRepoHost' | 'environmentSetup' | 'runnerPoolSetup'

/** The cause line and the action for one failure. */
export interface FailurePresentation {
  causeKey: string
  action: FailureAction
}

/**
 * The i18n key of a failure's one-line cause. The lists of earlier failures show this line
 * without an action, so it is a function of its own.
 */
export function failureCauseKey(failure: Pick<AgentFailure, 'kind' | 'reason'>): string {
  return failure.reason === GITHUB_NOT_CONNECTED
    ? 'errors.conflict.description.github_not_connected'
    : FAILURE_CAUSE_KEYS[failure.kind]
}

/**
 * The cause line and the action for a failure.
 *
 * `localMode` changes one case only: a `deploy_runner_unwired` cause on a local node is fixed
 * by an environment variable, not by the runner-pool tab, so that case opens the environment
 * tab, and the block shows the variable names in Details.
 */
export function presentFailure(
  failure: Pick<AgentFailure, 'kind' | 'reason'>,
  options: { localMode: boolean },
): FailurePresentation {
  const causeKey = failureCauseKey(failure)
  if (failure.reason === GITHUB_NOT_CONNECTED) return { causeKey, action: 'connectRepoHost' }
  if (failure.kind !== 'environment') return { causeKey, action: 'retry' }
  const toRunnerPool = failure.reason === DEPLOY_RUNNER_UNWIRED && !options.localMode
  return { causeKey, action: toRunnerPool ? 'runnerPoolSetup' : 'environmentSetup' }
}
