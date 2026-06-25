// Pure decision for the Tester's start-time infra gate — no IO, no ports. Given the
// runtime's Docker-in-Docker capability and the task/service test-infra config, decide
// whether a Tester pipeline may start, and if not, why. ExecutionService resolves the
// inputs (service config, environment-provider presence) and translates the verdict
// into an actionable ConflictError; keeping the branching here makes the whole matrix
// (incl. the "limited mode" of a runtime without nesting) trivially testable.

/** The Tester's resolved environment choice (`ephemeral` is the default when unset). */
export type TesterEnvironment = 'local' | 'ephemeral'

/**
 * Resolve a task's effective Tester environment from its own pinned choice, falling back
 * to the service frame's default, then the built-in `ephemeral`. This is the inheritance
 * the UI promises: the service sets the default a task is spawned with, the task's own
 * `tester.environment` config (when set) overrides it. Pure so both the start-time gate
 * and the agent-context materialisation agree on one answer.
 */
export function resolveTesterEnvironment(
  taskValue: string | undefined,
  serviceDefault: TesterEnvironment | undefined,
): TesterEnvironment {
  if (taskValue === 'local' || taskValue === 'ephemeral') return taskValue
  if (serviceDefault === 'local' || serviceDefault === 'ephemeral') return serviceDefault
  return 'ephemeral'
}

export interface TesterInfraInput {
  /** Whether the runtime can run local docker-compose infra via Docker-in-Docker. */
  localTestInfraSupported: boolean
  /** The task's resolved Tester environment. */
  environment: TesterEnvironment
  /** The service frame is marked as having no infra to stand up. */
  noInfraDependencies: boolean
  /** The service frame has a docker-compose path to stand its infra up. */
  hasComposePath: boolean
  /** An ephemeral-environment provider is wired (so a deployed URL can be provisioned). */
  hasEnvironmentProvider: boolean
}

export type TesterInfraDecision =
  | { ok: true }
  // A DinD-incapable runtime can't run the chosen `local` infra and the service isn't no-infra.
  | { ok: false; reason: 'limited-local' }
  // A DinD-incapable runtime with an `ephemeral` task but no provider → nothing to test against.
  | { ok: false; reason: 'limited-ephemeral-no-provider' }
  // A capable runtime with a `local` task whose service has neither compose path nor no-infra.
  | { ok: false; reason: 'local-unconfigured' }

/**
 * Decide whether a Tester pipeline may start.
 *
 * - **Limited mode** (runtime can't nest containers, e.g. Apple `container`): a `local`
 *   run is allowed only when the service stands nothing up (`noInfraDependencies`); an
 *   `ephemeral` run is allowed only when a provider is configured (else there's no URL,
 *   and no local fallback on this runtime).
 * - **Capable runtime**: `ephemeral` always passes (zero-config default); `local`
 *   requires the service to declare a compose path or no infra.
 */
export function decideTesterInfra(input: TesterInfraInput): TesterInfraDecision {
  if (!input.localTestInfraSupported) {
    if (input.environment === 'local') {
      return input.noInfraDependencies ? { ok: true } : { ok: false, reason: 'limited-local' }
    }
    return input.hasEnvironmentProvider
      ? { ok: true }
      : { ok: false, reason: 'limited-ephemeral-no-provider' }
  }

  if (input.environment !== 'local') return { ok: true }
  return input.noInfraDependencies || input.hasComposePath
    ? { ok: true }
    : { ok: false, reason: 'local-unconfigured' }
}

/** The actionable error message for each refusal reason. */
export const TESTER_INFRA_MESSAGES: Record<
  Exclude<TesterInfraDecision, { ok: true }>['reason'],
  string
> = {
  'limited-local':
    "This deployment's container runtime can't run the Tester's local docker-compose " +
    'infra (no Docker-in-Docker). Switch the Tester to the ephemeral environment (with an ' +
    "environment provider configured), or mark the service 'No infra dependencies', before " +
    'starting.',
  'limited-ephemeral-no-provider':
    "This deployment's container runtime can't run the Tester's local infra, and no " +
    'ephemeral environment provider is configured, so the Tester has nothing to test ' +
    'against. Configure an environment provider (ENVIRONMENTS_ENABLED + a connection), or ' +
    "mark the service 'No infra dependencies' and run the Tester locally.",
  'local-unconfigured':
    "This task's pipeline runs the Tester locally, but its service has no test infra " +
    "configured. Set the service's docker-compose path, or mark it as having no infra " +
    'dependencies, before starting — or switch the Tester to the ephemeral environment.',
}
