import type { Block, AgentRunContext } from '@cat-factory/kernel'
import type {
  FrontendConfig,
  LiveEnvRouteHandle,
  ResolvedFrontendBinding,
} from '@cat-factory/contracts'
import {
  boundServiceFrameIds,
  buildFrontendRunNotes,
  indexLiveServiceEnvRoutes,
  resolveFrontendBindings,
} from './frontend-infra.logic.js'

// ---------------------------------------------------------------------------
// The BUILDER's FRONTEND-frame resolver, extracted from `AgentContextBuilder` as a cohesive
// collaborator (the file-size ratchet's split trigger). One question, asked from two sides: what
// concrete upstreams does this frontend's UI test run against? The agent-context projection and
// the run-start snapshot the SPA renders are two shapes of the same answer, and they share the
// ONE environment read that produces it, so they belong together and away from everything else
// the builder resolves.
//
// The rules themselves are `@cat-factory/contracts`' (`resolveFrontendBindings`,
// `buildFrontendRunNotes`, `indexLiveServiceEnvRoutes`), shared with the SPA. What lives here is
// the IO step and the two projections.
// ---------------------------------------------------------------------------

/** What resolving a frontend frame needs from the builder's dependency object. */
export interface FrontendResolutionDeps {
  /**
   * Every live environment handle in the workspace, in ONE read. Absent (the environment module
   * unwired) is a normal deployment state and resolves every binding to a mock, exactly as a
   * workspace with nothing provisioned does.
   */
  listLiveEnvHandles?: (workspaceId: string) => Promise<readonly LiveEnvRouteHandle[]>
}

/**
 * A frontend frame's config plus, per bound service FRAME, where its live environment is: the URL,
 * and the address the platform proved carries traffic for that URL's host when its name did not.
 *
 * The two maps travel together because they come from one index over one read, and every consumer
 * of the URL is a consumer of the address: a binding resolved to a name nothing can look up needs
 * the mapping as much as the run's own environment does.
 */
export interface FrontendResolution {
  config: FrontendConfig
  liveServiceEnvUrls: Map<string, string>
  liveServiceEnvAddresses: Map<string, string>
}

/**
 * Resolve a frontend frame's config and the live environments of the services it binds, or
 * undefined for any frame that is not a `type: 'frontend'` carrying a `frontendConfig` (so the
 * context stays unchanged for backend services).
 *
 * The live environments are read ONCE and indexed by service-frame id, never a per-binding point
 * read (the N+1 the "reuse an already-fetched list" rule bans), so this is a single query
 * regardless of binding count. The frame-keyed newest-wins indexing is the shared helper's, which
 * also pairs each URL with the address PROVED to carry for it OFF THE SAME HANDLE: a bound peer
 * reachable only by address fails a UI test on name resolution exactly as the run's own
 * environment would, and one index is what stops the URL and the address coming from two different
 * environments of the same frame.
 */
export async function resolveFrontendFrame(
  deps: FrontendResolutionDeps,
  workspaceId: string,
  frame: Block | null,
): Promise<FrontendResolution | undefined> {
  if (!frame || frame.type !== 'frontend' || !frame.frontendConfig) return undefined
  const config = frame.frontendConfig
  // The distinct service FRAMES this frontend binds: the only envs whose live URLs matter.
  const serviceFrameIds = boundServiceFrameIds(config)
  const routes =
    deps.listLiveEnvHandles && serviceFrameIds.size > 0
      ? indexLiveServiceEnvRoutes(await deps.listLiveEnvHandles(workspaceId), serviceFrameIds)
      : { urls: new Map<string, string>(), addresses: new Map<string, string>() }
  return { config, liveServiceEnvUrls: routes.urls, liveServiceEnvAddresses: routes.addresses }
}

/**
 * The agent-context shape: the frame's build/serve/mock config plus each surviving binding already
 * resolved to a concrete upstream. Each `service` binding whose bound service has a live
 * environment becomes the service under test (its real URL, and the proved address when its name
 * did not carry); every other upstream is left for the harness to mock.
 */
export function frontendAgentContext(
  resolution: FrontendResolution,
): NonNullable<AgentRunContext['frontend']> {
  const { config, liveServiceEnvUrls, liveServiceEnvAddresses } = resolution
  return {
    config,
    bindings: resolveFrontendBindings(config, liveServiceEnvUrls, liveServiceEnvAddresses),
  }
}

/**
 * The run-start snapshot: the same resolved bindings plus the non-fatal advisories
 * ({@link buildFrontendRunNotes}). The engine stamps both on the run at start, so the SPA's
 * run/step detail projects the frozen start-time resolution with no live-env read at view time,
 * and it stays truthful after the environments are torn down.
 */
export function frontendRunInfo(resolution: FrontendResolution): {
  bindings: ResolvedFrontendBinding[]
  notes: string[]
} {
  return {
    bindings: frontendAgentContext(resolution).bindings,
    notes: buildFrontendRunNotes(resolution.config, resolution.liveServiceEnvUrls),
  }
}
