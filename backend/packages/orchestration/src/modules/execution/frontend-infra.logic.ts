import type { FrontendConfig, ResolvedFrontendBinding } from '@cat-factory/kernel'

// Pure decisions for the self-contained frontend UI-test flow — no IO, no ports. The binding
// RESOLUTION helpers themselves (resolve each backend binding to a concrete upstream, index the
// live env URLs, build the run-start notes) now live in `@cat-factory/contracts` so the SPA and
// the backend share ONE source of truth (next to `frontendOriginsForService`); they are
// re-exported here so the orchestration importers (AgentContextBuilder, ExecutionService, the
// existing tests, the preview job builder) are unchanged. What stays here is the pair of
// gate-only predicates the run-start check reads.
//
// The model: a frontend declares backend BINDINGS (env-var name → where its URL resolves). EACH
// `service` binding whose bound service has a LIVE ephemeral env resolves to that service's real
// URL (a "service under test" — there may be more than one live at once); every `mock` binding —
// and every `service` with no live env — is left for the harness to mock with WireMock. A UI test
// needs at least ONE live service under test, else no real upstream URL resolved and there is
// nothing meaningful to exercise.

export {
  boundServiceFrameIds,
  buildFrontendRunNotes,
  indexLiveServiceEnvUrls,
  resolveFrontendBindings,
} from '@cat-factory/contracts'
export type { LiveEnvHandle, ResolvedFrontendBinding } from '@cat-factory/contracts'

/** Whether any resolved binding points at a live service under test (gates the UI-test start). */
export function hasLiveServiceBinding(bindings: readonly ResolvedFrontendBinding[]): boolean {
  return bindings.some((b) => b.serviceUrl !== undefined)
}

/**
 * Whether the frontend declares any live-backend `service` binding (a real upstream it expects
 * to test against, as opposed to a `mock`). A frontend with none is fully served by WireMock +
 * the static server, so the start gate lets it run even with no live service under test.
 */
export function hasServiceBinding(config: FrontendConfig): boolean {
  return config.backendBindings.some(
    (b) => b.source.kind === 'service' && b.envVar.trim().length > 0,
  )
}
