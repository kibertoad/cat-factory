import type { ProvisionType } from '@cat-factory/kernel'
import {
  ENV_CONSUMER_STARVATION_REASONS,
  pipelineEnvironmentProblems,
} from '@cat-factory/contracts'
import type {
  EnvConsumerStarvationReason,
  PipelineEnvironmentProblem,
} from '@cat-factory/contracts'

// Pure decision for the Tester's start-time infra gate — no IO, no ports. Given the
// service's declared provision type and whether a workspace handler resolves for the type,
// decide whether a Tester pipeline may start. ExecutionService resolves the inputs (the
// service frame's `provisioning`, the handler resolution) and translates the verdict into an
// actionable ConflictError; keeping the branching here makes the whole matrix trivially testable.
//
// The collapse (per-service provision types): there is no longer a per-task/per-service
// `local` vs `ephemeral` toggle. A service declares a provision TYPE and the workspace
// owns HOW each type is handled; the Tester just needs SOME way to stand its system up:
//   - `infraless` (or no provisioning declared) → run with no infra.
//   - `docker-compose` / `kubernetes` / `custom` → the env is provisioned by the single
//     Deployer step through a workspace handler, so one must resolve for the service's type
//     (else there's nothing to test against). Docker-compose used to be a special in-container
//     (DinD) case; since the shared-stacks wizard configures a `docker-compose` handler and the
//     Deployer became the sole compose provisioner, it is handler-based like the others.

export interface TesterInfraInput {
  /**
   * Frontend UI-test infra (the self-contained `tester-ui` flow). Present ONLY when the
   * frame under test is a `type: 'frontend'` app — and then it takes precedence over the
   * backend-service branch below (a frontend declares `frontendConfig`, not `provisioning`).
   * A frontend needs no Docker-in-Docker (WireMock + a static server are plain processes), so
   * the gate is narrow: a frontend that declares one or more live-backend `service` bindings
   * (`hasServiceBindings`) needs at least one of them actually LIVE (`hasLiveService`) to be
   * the "service under test". A frontend that binds no `service` at all (only mocks, or none)
   * is fully stood up by WireMock + the static server, so it passes with nothing to gate.
   */
  frontend?: { hasServiceBindings: boolean; hasLiveService: boolean }
  /** The service frame's declared provision type, or undefined when none is set. */
  provisionType: ProvisionType | undefined
  /**
   * Whether a workspace handler resolves for the service's declared type. Consulted for
   * `docker-compose`/`kubernetes`/`custom` (all Deployer-provisioned; `infraless`/none stands
   * nothing up). Pass `true` when the resolution seam is unwired (tests / no environment
   * integration) so the gate passes through.
   */
  handlerResolves: boolean
}

export type TesterInfraDecision =
  | { ok: true }
  // A `docker-compose`/`kubernetes`/`custom` service with no workspace handler that resolves for its type.
  | { ok: false; reason: 'provision-type-unhandled' }
  // A `frontend` frame with no bound service that has a live ephemeral env (no service under test).
  | { ok: false; reason: 'frontend-no-live-service' }

/**
 * Decide whether a Tester pipeline may start. A `frontend` frame (the self-contained UI-test
 * flow) is decided FIRST: it passes unless it declares live-backend `service` bindings with
 * none actually live (nothing to exercise as the service under test); a mock-only / no-binding
 * frontend passes. Otherwise the backend service branch: `infraless`/none always passes (the
 * Tester stands nothing up); `docker-compose`/`kubernetes`/`custom` pass only when a workspace
 * handler resolves (all provisioned by the single Deployer step).
 */
export function decideTesterInfra(input: TesterInfraInput): TesterInfraDecision {
  if (input.frontend) {
    const { hasServiceBindings, hasLiveService } = input.frontend
    return !hasServiceBindings || hasLiveService
      ? { ok: true }
      : { ok: false, reason: 'frontend-no-live-service' }
  }
  const type = input.provisionType
  if (!type || type === 'infraless') return { ok: true }
  // `docker-compose` | `kubernetes` | `custom` — provisioned by the Deployer via a workspace handler.
  return input.handlerResolves ? { ok: true } : { ok: false, reason: 'provision-type-unhandled' }
}

/**
 * The steps that CONSUME a provisioned environment to run against — the API/UI testers, the
 * acceptance (`playwright`) runner, and the human-test gate. On a `kubernetes`/`custom` service each
 * needs a `deployer` to have stood the environment up first (they read its coordinates, they never
 * provision themselves), so a chain that reaches one without a preceding deployer would dead-end.
 *
 * Re-exported from `@cat-factory/contracts`, which owns the list: the SPA's pipeline builder warns
 * about the same set while a draft is being composed, and the save boundary refuses it. This
 * module's remaining job is the SERVICE-AWARE half, whether the service under test stands an
 * environment up at all, which only the run door can answer.
 */
export { ENV_CONSUMER_AGENT_KINDS as ENV_CONSUMER_KINDS } from '@cat-factory/contracts'

/**
 * For a Deployer-provisioned service (`docker-compose`/`kubernetes`/`custom`): the FIRST step in the
 * ENABLED chain that would dead-end for want of a live environment, or `null` when none would.
 * `ExecutionService` resolves the service's provision type and translates a returned problem into an
 * actionable launch error. Returns `null` for `infraless`/none/a frontend frame, where nothing is
 * provisioned and so nothing can be missing.
 *
 * The ORDERING is not re-derived here: it is {@link pipelineEnvironmentProblems}, the same function
 * the builder warns on and the save boundary refuses on, filtered to the two reasons that describe a
 * dead end rather than an untidy lifecycle. A second hand-written walk beside it is what let the
 * run door check the deployer→consumer direction and miss the consumer→disposer one, agreeing with
 * the save boundary only because both copies had the same hole.
 *
 * What stays here is the half the shared rule structurally cannot answer: whether the SERVICE this
 * run was started against stands an environment up at all. That split is also why the run door
 * refuses this subset only. The save boundary binds what is being AUTHORED and may hold a draft to
 * the whole lifecycle; the run door meets pipelines STORED before any of it existed, and a chain
 * whose environment merely goes unreclaimed still runs.
 */
export function consumerEnvironmentFault(
  agentKinds: readonly string[],
  enabled: readonly boolean[] | undefined,
  provisionType: ProvisionType | undefined,
): ConsumerEnvironmentFault | null {
  if (
    provisionType !== 'docker-compose' &&
    provisionType !== 'kubernetes' &&
    provisionType !== 'custom'
  ) {
    return null
  }
  return pipelineEnvironmentProblems(agentKinds, enabled).find(isStarvation) ?? null
}

/** One lifecycle fault, narrowed to the reasons this door refuses. */
export type ConsumerEnvironmentFault = PipelineEnvironmentProblem & {
  reason: EnvConsumerStarvationReason
}

/**
 * Narrowed by the same list the messages are keyed by, so a reason added to that list is carried
 * through the guard and the copy together rather than silently falling out of one of them.
 */
function isStarvation(problem: PipelineEnvironmentProblem): problem is ConsumerEnvironmentFault {
  return (ENV_CONSUMER_STARVATION_REASONS as readonly string[]).includes(problem.reason)
}

/**
 * The actionable launch error for each way a stored chain starves its env-consuming step, naming
 * the step and the edit that fixes it. Separate sentences per reason because the fixes are
 * opposite: one chain never provisions, the other reclaims too early.
 */
export const CONSUMER_ENVIRONMENT_FAULT_MESSAGES: Record<
  EnvConsumerStarvationReason,
  (agentKind: string, provisionType: string) => string
> = {
  consumer_without_deployer: (agentKind, provisionType) =>
    `This service provisions a '${provisionType}' environment, but this pipeline has no Deployer ` +
    `step before its '${agentKind}' step, so the environment would never be stood up. Add a ` +
    'Deployer step before it in the pipeline builder, reseed this pipeline to the latest built-in ' +
    '(which includes one), or set the service to docker-compose / infraless.',
  consumer_after_disposer: (agentKind, provisionType) =>
    `This service provisions a '${provisionType}' environment, but this pipeline's Disposer step ` +
    `reclaims it before the '${agentKind}' step that reads it runs, so there would be nothing ` +
    'left to run against. Move the Disposer after that step in the pipeline builder, or add ' +
    'another Deployer before it.',
}

/** The actionable error message for each refusal reason. */
export const TESTER_INFRA_MESSAGES: Record<
  Exclude<TesterInfraDecision, { ok: true }>['reason'],
  string
> = {
  'provision-type-unhandled':
    "This workspace has no handler configured for the service's provision type, so the " +
    'Tester has no environment to run against. Configure an infrastructure handler for the ' +
    'type (Settings → Infrastructure), or mark the service `infraless`, before starting.',
  'frontend-no-live-service':
    'This frontend has no bound backend service with a live ephemeral environment, so the ' +
    'UI test has no service under test to run against. Provision an environment for one of ' +
    'the services this frontend binds (its `service` binding), or bind one, before starting.',
}
