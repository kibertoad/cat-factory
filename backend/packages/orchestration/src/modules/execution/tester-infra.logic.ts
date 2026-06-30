import type { ProvisionType } from '@cat-factory/kernel'

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

/**
 * Decide whether a Tester pipeline may start, from the service's declared provision type.
 * `infraless`/none always passes (the Tester stands nothing up); `docker-compose` passes
 * only on a DinD-capable runtime AND when a compose path is declared; `kubernetes`/`custom`
 * passes only when a workspace handler resolves for the type.
 */
export function decideTesterInfra(input: TesterInfraInput): TesterInfraDecision {
  const type = input.provisionType
  if (!type || type === 'infraless') return { ok: true }
  if (type === 'docker-compose') {
    if (!input.localTestInfraSupported) return { ok: false, reason: 'limited-local' }
    return input.hasComposePath ? { ok: true } : { ok: false, reason: 'compose-unconfigured' }
  }
  // `kubernetes` | `custom` — provisioned externally by a workspace handler.
  return input.handlerResolves ? { ok: true } : { ok: false, reason: 'provision-type-unhandled' }
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
}
