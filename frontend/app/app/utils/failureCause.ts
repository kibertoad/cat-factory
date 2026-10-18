// ---------------------------------------------------------------------------
// What a failed run tells the person who looks at it: one translated cause line, the one action
// that most probably fixes it, and the setting that fixes it when there is one.
//
// The backend sends its own English `hint` for each failure kind. That text explains the
// runtime to the person who operates the deployment, so the SPA shows it only behind the
// failure block's Details toggle. The cause line here is the SPA's own copy, keyed by the
// machine-readable `reason` first and the `kind` second, so it is translated and it says if a
// retry will probably work.
//
// A `reason` that names a refusal (a conflict the run hit before it started) reads its copy and
// its fix from `utils/conflictCopy.ts`, the table the toast reads, so the two surfaces state one
// refusal the same way. `FAILURE_CAUSE_KEYS` is an exhaustive `Record<AgentFailureKind, …>`, so a
// kind added to the contract fails the typecheck here. A kind that a release retired can still
// arrive on a stored run, so the lookup narrows through `isAgentFailureKind` and names such a kind
// as `unknown`.
// ---------------------------------------------------------------------------

import { isAgentFailureKind } from '@cat-factory/contracts'
import type { EnvironmentFailureReason } from '@cat-factory/contracts'
import type { AgentFailure, AgentFailureKind } from '~/types/execution'
import type { AgentRunSummary } from '~/stores/agentRuns'
import { refusalCopy, type ConflictAction } from '~/utils/conflictCopy'

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

const DEPLOY_RUNNER_UNWIRED: EnvironmentFailureReason = 'deploy_runner_unwired'

/** The environment variable that sets a local node's deploy runtime. */
const LOCAL_DEPLOY_RUNTIME_VARIABLE = 'LOCAL_DEPLOY_RUNTIME'

/** The settings that fix an `environment` failure, as the same shape a refusal's fix has. */
const ENVIRONMENT_SETUP: ConflictAction = {
  labelKey: 'board.failure.environmentSetup',
  icon: 'i-lucide-settings',
  run: (ui) => ui.openProviderConnection('environment'),
}
const RUNNER_POOL_SETUP: ConflictAction = {
  labelKey: 'board.failure.deployRunnerSetup',
  icon: 'i-lucide-settings',
  run: (ui) => ui.openProviderConnection('runner-pool'),
}

/** Which run failed: a task run (`execution`) or a single-job run. */
export type FailureRunKind = AgentRunSummary['kind']

/**
 * The one action the failure block offers.
 *
 * - `retry`: run the work again. Most causes are temporary or are fixed in the run itself. When a
 *   setting can also be the cause, the block shows that setting beside Retry (`fix`).
 * - `fix`: a setting must change before a retry can work (no repository host, no AI provider, no
 *   deploy runner), so the block opens that setting (`fix`), and Retry waits in Details.
 * - `newRun`: the run's saved state cannot be read, so a retry reads the same broken state. The
 *   block starts the run's pipeline again as a new run, and Retry waits in Details.
 */
export type FailureAction = 'retry' | 'fix' | 'newRun'

/** What the failure block shows for one failure. */
export interface FailurePresentation {
  /** The title a refusal names, or null for the block's own per-kind title. */
  titleKey: string | null
  causeKey: string
  causeParams: Record<string, string>
  action: FailureAction
  /** The setting that fixes the cause: the action itself for `fix`, a second button for `retry`. */
  fix: ConflictAction | null
}

/** What decides the presentation, besides the failure itself. */
export interface FailureContext {
  runKind: FailureRunKind
  /**
   * A local node. There a `deploy_runner_unwired` cause is fixed by an environment variable,
   * not by a settings tab, so it gets its own cause line and Retry.
   */
  localMode: boolean
}

type FailureFacts = Pick<AgentFailure, 'kind' | 'reason'>

/**
 * Whether the failure is an unwired deploy runner on a local node, where the fix is a variable in
 * `.env`. The block names the variable in its cause line and, for a Kubernetes service, shows the
 * other variables under it. One rule for both, so they cannot disagree.
 */
export function isLocalDeployRunnerUnwired(
  failure: FailureFacts,
  context: FailureContext,
): boolean {
  return (
    context.localMode && failure.kind === 'environment' && failure.reason === DEPLOY_RUNNER_UNWIRED
  )
}

/** What the failure block shows for a failure. */
export function presentFailure(
  failure: FailureFacts,
  context: FailureContext,
): FailurePresentation {
  const refusal = refusalCopy(failure.reason)
  if (refusal) {
    return {
      titleKey: refusal.titleKey,
      causeKey: refusal.descriptionKey,
      causeParams: {},
      action: refusal.action ? 'fix' : 'retry',
      fix: refusal.action ?? null,
    }
  }
  if (isLocalDeployRunnerUnwired(failure, context)) {
    return {
      titleKey: null,
      causeKey: 'board.failure.cause.deployRunnerUnwiredLocal',
      causeParams: { variable: LOCAL_DEPLOY_RUNTIME_VARIABLE },
      action: 'retry',
      fix: null,
    }
  }
  const kind: AgentFailureKind = isAgentFailureKind(failure.kind) ? failure.kind : 'unknown'
  const singleJobKey = context.runKind === 'execution' ? undefined : SINGLE_JOB_CAUSE_KEYS[kind]
  const base = {
    titleKey: null,
    causeKey: singleJobKey ?? FAILURE_CAUSE_KEYS[kind],
    causeParams: {},
  }
  if (kind === 'environment') {
    // No deploy runner is wired: a retry fails the same way until it is. Any other environment
    // failure is most often a temporary provider fault, so Retry leads and the settings are beside.
    return failure.reason === DEPLOY_RUNNER_UNWIRED
      ? { ...base, action: 'fix', fix: RUNNER_POOL_SETUP }
      : { ...base, action: 'retry', fix: ENVIRONMENT_SETUP }
  }
  if (kind === 'state_unreadable' && context.runKind === 'execution') {
    return { ...base, action: 'newRun', fix: null }
  }
  return { ...base, action: 'retry', fix: null }
}

/**
 * A failure's full output, or null when there is none to show: the detail often repeats the
 * message word for word, and the message is already on screen. One rule for every surface that
 * shows a failure's output.
 */
export function failureOutput(failure: Pick<AgentFailure, 'message' | 'detail'>): string | null {
  return failure.detail && failure.detail !== failure.message ? failure.detail : null
}
