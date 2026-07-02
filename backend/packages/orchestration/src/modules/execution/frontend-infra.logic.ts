import type { FrontendConfig } from '@cat-factory/kernel'

// Pure decisions for the self-contained frontend UI-test flow — no IO, no ports. Given a
// frontend frame's `frontendConfig` and the live ephemeral-env URLs of the services it binds,
// resolve each backend binding to a concrete upstream and decide whether a `tester-ui` run may
// start. AgentContextBuilder resolves the inputs (the frame's config, the live env URLs read
// once via listHandles) and ExecutionService translates the gate verdict into a ConflictError;
// keeping the branching here makes the whole matrix trivially testable.
//
// The model: a frontend declares backend BINDINGS (env-var name → where its URL resolves). EACH
// `service` binding whose bound service has a LIVE ephemeral env resolves to that service's real
// URL (a "service under test" — there may be more than one live at once); every `mock` binding —
// and every `service` with no live env — is left for the harness to mock with WireMock. A UI test
// needs at least ONE live service under test, else no real upstream URL resolved and there is
// nothing meaningful to exercise.

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

/** A live-environment handle as far as the frontend binding resolution cares. */
export interface LiveEnvHandle {
  frameId?: string | null
  url?: string | null
  status: string
  createdAt: number
}

/**
 * Index a workspace's live-environment handles to a `serviceFrameId → url` map for the service
 * FRAMES a frontend binds. A binding's `serviceBlockId` names a service FRAME, so we match on the
 * handle's `frameId` (the deployer's block walked up to its frame), NOT `blockId` (the task the
 * deployer ran on). A frame can hold more than one live env (two tasks under it each ran a
 * deployer, since supersede is per-task `blockId`), so keep the NEWEST by `createdAt` — the same
 * "current env wins" rule the tester point-read applies via `ORDER BY created_at DESC`. Shared by
 * `AgentContextBuilder.resolveFrontendConfig` (the UI-test flow) and the preview job builder so the
 * two can't drift on which env a live `service` binding resolves to.
 */
export function indexLiveServiceEnvUrls(
  handles: Iterable<LiveEnvHandle>,
  serviceFrameIds: ReadonlySet<string>,
): Map<string, string> {
  const liveServiceEnvUrls = new Map<string, string>()
  if (serviceFrameIds.size === 0) return liveServiceEnvUrls
  const newestAt = new Map<string, number>()
  for (const handle of handles) {
    if (
      handle.frameId &&
      handle.url &&
      handle.status === 'ready' &&
      serviceFrameIds.has(handle.frameId) &&
      handle.createdAt >= (newestAt.get(handle.frameId) ?? Number.NEGATIVE_INFINITY)
    ) {
      newestAt.set(handle.frameId, handle.createdAt)
      liveServiceEnvUrls.set(handle.frameId, handle.url)
    }
  }
  return liveServiceEnvUrls
}

/** The distinct service FRAME ids a frontend config binds via a live-`service` source. */
export function boundServiceFrameIds(config: FrontendConfig): Set<string> {
  return new Set(
    config.backendBindings
      .filter((b) => b.source.kind === 'service')
      .map((b) => (b.source as { serviceBlockId: string }).serviceBlockId),
  )
}

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
