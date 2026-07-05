import type { ProvisionType } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import { HUMAN_TEST_AGENT_KIND, TESTER_KINDS } from './ci.logic.js'
import { ACCEPTANCE_AGENT_KINDS } from '@cat-factory/agents'

// Pure decision for the Tester's start-time infra gate — no IO, no ports. Given the
// service's declared provision type, the runtime's Docker-in-Docker capability, and
// whether a workspace handler resolves for the type, decide whether a Tester pipeline
// may start. ExecutionService resolves the inputs (the service frame's `provisioning`,
// the handler resolution) and translates the verdict into an actionable ConflictError;
// keeping the branching here makes the whole matrix trivially testable.
//
// The collapse (per-service provision types): there is no longer a per-task/per-service
// `local` vs `ephemeral` toggle. A service declares a provision TYPE and the workspace
// owns HOW each type is handled; the Tester just needs SOME way to stand its system up:
//   - `infraless` (or no provisioning declared) → run with no infra.
//   - `docker-compose` → the harness stands the compose stack up IN-CONTAINER (DinD), so
//     a runtime that can't nest containers (Apple `container`) refuses up front, and the
//     service must declare a compose path (else there's nothing to stand up).
//   - `kubernetes` / `custom` → the env is provisioned by a workspace handler, so one must
//     resolve for the service's type (else there's nothing to test against).

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
  /** Whether the runtime can run an in-container docker-compose stack via Docker-in-Docker. */
  localTestInfraSupported: boolean
  /**
   * Whether the `docker-compose` service declares a compose path. Consulted ONLY for
   * `docker-compose` — the harness stands nothing up without one, so a `docker-compose`
   * service with no path can't run a meaningful Tester. Ignored for the other types.
   */
  hasComposePath: boolean
  /**
   * Whether a workspace handler resolves for the service's declared type. Consulted ONLY
   * for `kubernetes`/`custom` (a `docker-compose` stack runs in-container with no handler,
   * `infraless`/none stands nothing up). Pass `true` when the resolution seam is unwired
   * (tests / no environment integration) so the gate passes through.
   */
  handlerResolves: boolean
}

export type TesterInfraDecision =
  | { ok: true }
  // A `docker-compose` service on a runtime that can't nest containers (no DinD).
  | { ok: false; reason: 'limited-local' }
  // A `docker-compose` service that declares no compose path (nothing to stand up).
  | { ok: false; reason: 'compose-unconfigured' }
  // A `kubernetes`/`custom` service with no workspace handler that resolves for its type.
  | { ok: false; reason: 'provision-type-unhandled' }
  // A `frontend` frame with no bound service that has a live ephemeral env (no service under test).
  | { ok: false; reason: 'frontend-no-live-service' }

/**
 * Decide whether a Tester pipeline may start. A `frontend` frame (the self-contained UI-test
 * flow) is decided FIRST: it passes unless it declares live-backend `service` bindings with
 * none actually live (nothing to exercise as the service under test); a mock-only / no-binding
 * frontend passes. Otherwise the backend service branch: `infraless`/none always passes (the
 * Tester stands nothing up); `docker-compose` passes only on a DinD-capable runtime AND when a
 * compose path is declared; `kubernetes`/`custom` passes only when a workspace handler resolves.
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
  if (type === 'docker-compose') {
    if (!input.localTestInfraSupported) return { ok: false, reason: 'limited-local' }
    return input.hasComposePath ? { ok: true } : { ok: false, reason: 'compose-unconfigured' }
  }
  // `kubernetes` | `custom` — provisioned externally by a workspace handler.
  return input.handlerResolves ? { ok: true } : { ok: false, reason: 'provision-type-unhandled' }
}

/**
 * The steps that CONSUME a provisioned environment to run against — the API/UI testers, the
 * acceptance (`playwright`) runner, and the human-test gate. On a `kubernetes`/`custom` service each
 * needs a `deployer` to have stood the environment up first (they read its coordinates, they never
 * provision themselves), so a chain that reaches one without a preceding deployer would dead-end.
 */
export const ENV_CONSUMER_KINDS: readonly string[] = [
  ...TESTER_KINDS,
  ...ACCEPTANCE_AGENT_KINDS,
  HUMAN_TEST_AGENT_KIND,
]

/**
 * For a `kubernetes`/`custom` service: whether the ENABLED chain reaches an env-consuming step
 * (tester / playwright / human-test) with NO enabled `deployer` before it — i.e. nothing would
 * provision the environment the consumer needs, so the run would dead-end inside the consumer. The
 * pure half of the run-start guard: `ExecutionService` resolves the service's provision type and
 * translates a `true` verdict into an actionable launch error. Returns false for every other
 * provision type (a `docker-compose` tester stands its stack up in-container; `infraless`/none/a
 * frontend frame need no deployer) and whenever a deployer precedes the first consumer.
 */
export function needsDeployerBeforeConsumer(
  agentKinds: readonly string[],
  enabled: readonly boolean[] | undefined,
  provisionType: ProvisionType | undefined,
): boolean {
  if (provisionType !== 'kubernetes' && provisionType !== 'custom') return false
  let deployerSeen = false
  for (let i = 0; i < agentKinds.length; i++) {
    if (enabled?.[i] === false) continue
    const kind = agentKinds[i]!
    if (kind === DEPLOYER_AGENT_KIND) deployerSeen = true
    else if (!deployerSeen && ENV_CONSUMER_KINDS.includes(kind)) return true
  }
  return false
}

/** The actionable error message for each refusal reason. */
export const TESTER_INFRA_MESSAGES: Record<
  Exclude<TesterInfraDecision, { ok: true }>['reason'],
  string
> = {
  'limited-local':
    "This deployment's container runtime can't run the Tester's local docker-compose infra " +
    '(no Docker-in-Docker). Mark the service as `infraless`, or run it on a runtime that ' +
    'supports nested containers, before starting.',
  'compose-unconfigured':
    'This service is `docker-compose` but declares no compose path, so the Tester has no ' +
    'infra to stand up. Set the service’s docker-compose path, or mark it `infraless`, ' +
    'before starting.',
  'provision-type-unhandled':
    "This workspace has no handler configured for the service's provision type, so the " +
    'Tester has no environment to run against. Configure an infrastructure handler for the ' +
    'type (Settings → Infrastructure), or mark the service `infraless`, before starting.',
  'frontend-no-live-service':
    'This frontend has no bound backend service with a live ephemeral environment, so the ' +
    'UI test has no service under test to run against. Provision an environment for one of ' +
    'the services this frontend binds (its `service` binding), or bind one, before starting.',
}
