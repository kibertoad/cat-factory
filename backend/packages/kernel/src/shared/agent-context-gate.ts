import { DEFAULT_WORKSPACE_SETTINGS } from '../domain/catalog.js'
import { readCachedWorkspaceSettings } from '../ports/caching.js'
import type { GroupCacheHandle, WorkspaceSettingsCacheValue } from '../ports/caching.js'
import type { WorkspaceSettingsRepository } from '../ports/workspace-settings-repositories.js'

/**
 * Whether prompt/response BODIES may be captured for a workspace — the per-workspace half of
 * the double gate, asked once per recorded call.
 */
export type StoreAgentContextGate = (workspaceId: string | null) => Promise<boolean>

/**
 * The per-workspace `storeAgentContext` half of the double gate that governs body capture
 * across EVERY observability path: the deployment-wide `LLM_RECORD_PROMPTS` switch AND the
 * workspace's own toggle, the operator opt-out winning.
 *
 * It lives in kernel, as ONE factory, because the two paths already diverged once: the proxied
 * path (`LlmObservabilityService`) consulted both switches while the inline one
 * (`InstrumentedModelProvider`, feeding Langfuse/OTel for judges, consensus, the requirements
 * writer and every other inline kind) honoured only the deployment switch — so a workspace that
 * had explicitly opted out still shipped its inline prompt and response bodies to an external
 * trace backend. That was a privacy defect, not a coverage gap
 * (observability-logging-gaps.md, C2). Closing it with a second implementation of the same rule
 * left the two free to drift again; this is the one they now share.
 *
 * A new body-capturing path builds its gate here rather than re-deriving the rule.
 *
 * Two `true` answers are deliberate, not lenient defaults:
 *  - **No settings source wired** — there is no stored opt-out to honour, so the deployment's
 *    own `LLM_RECORD_PROMPTS` switch governs alone.
 *  - **No workspace on the call** — an untagged call has no workspace whose opt-out could
 *    apply, so again the deployment switch alone governs it.
 *
 * A read that THROWS is deliberately NOT handled here: the caller decides, and both callers
 * fail closed on it, because an unreadable settings row is not consent.
 */
export function createStoreAgentContextGate(deps: {
  repository?: WorkspaceSettingsRepository
  /**
   * The shared `AppCaches.workspaceSettings` slice, when the facade has one to hand. This read
   * runs per recorded call, so caching it (invalidated by `WorkspaceSettingsService.update`)
   * avoids a DB read per call. Absent ⇒ a direct repository read, which is the Worker's
   * situation and costs nothing: `workspaceSettings` is `enabled: false` in the isolate-safe
   * profile (our own mutable state, with no cross-isolate invalidation bus), so the slice would
   * be a pass-through there anyway.
   */
  cache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
}): StoreAgentContextGate {
  const { repository, cache } = deps
  if (!repository) return () => Promise.resolve(true)
  return async (workspaceId: string | null): Promise<boolean> => {
    if (!workspaceId) return true
    const settings =
      (await readCachedWorkspaceSettings(cache, repository, workspaceId)) ??
      DEFAULT_WORKSPACE_SETTINGS
    return settings.storeAgentContext
  }
}
