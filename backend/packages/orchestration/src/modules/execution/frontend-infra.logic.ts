import type { FrontendConfig } from '@cat-factory/kernel'

// Pure decisions for the self-contained frontend UI-test flow — no IO, no ports. Given a
// frontend frame's `frontendConfig` and the live ephemeral-env URLs of the services it binds,
// resolve each backend binding to a concrete upstream and decide whether a `tester-ui` run may
// start. AgentContextBuilder resolves the inputs (the frame's config, the live env URLs read
// once via listHandles) and ExecutionService translates the gate verdict into a ConflictError;
// keeping the branching here makes the whole matrix trivially testable.
//
// The model: a frontend declares backend BINDINGS (env-var name → where its URL resolves). A
// `service` binding whose bound service has a LIVE ephemeral env is the "service under test"
// (its real URL); every `mock` binding — and every `service` with no live env — is left for the
// harness to mock with WireMock. A UI test needs at least one live service under test, else the
// service-under-test URL is missing and there is nothing meaningful to exercise.

/** A frontend backend binding resolved to a concrete upstream for the UI-test run. */
export interface ResolvedFrontendBinding {
  /** The frontend's env var for this upstream URL (e.g. `PUB_BACKEND_URL`). */
  envVar: string
  /** The bound service's live ephemeral env URL (the service under test); absent ⇒ mock it. */
  serviceUrl?: string
}

/**
 * Resolve a frontend frame's backend bindings to concrete upstreams. Each `service` binding
 * whose service block id is in `liveServiceEnvUrls` becomes the service under test (its real
 * URL); every `mock` source — and every `service` with no live env — is left for the harness
 * to mock (no `serviceUrl`). Empty env-var bindings (an unfinished inspector row, allowed by
 * the schema) are dropped so nothing inert is ever injected.
 */
export function resolveFrontendBindings(
  config: FrontendConfig,
  liveServiceEnvUrls: ReadonlyMap<string, string>,
): ResolvedFrontendBinding[] {
  const resolved: ResolvedFrontendBinding[] = []
  for (const binding of config.backendBindings) {
    const envVar = binding.envVar.trim()
    if (!envVar) continue
    const serviceUrl =
      binding.source.kind === 'service'
        ? liveServiceEnvUrls.get(binding.source.serviceBlockId)
        : undefined
    resolved.push(serviceUrl ? { envVar, serviceUrl } : { envVar })
  }
  return resolved
}

/** Whether any resolved binding points at a live service under test (gates the UI-test start). */
export function hasLiveServiceBinding(bindings: readonly ResolvedFrontendBinding[]): boolean {
  return bindings.some((b) => b.serviceUrl !== undefined)
}
