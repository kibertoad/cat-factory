import type { WorkspaceBodiesGate } from '@cat-factory/agents'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  readCachedWorkspaceSettings,
  type GroupCacheHandle,
  type WorkspaceSettingsCacheValue,
  type WorkspaceSettingsRepository,
} from '@cat-factory/kernel'

/**
 * Build the per-workspace `storeAgentContext` gate the INLINE LLM path applies to
 * prompt/response bodies before they reach a trace sink.
 *
 * This is deliberately the same rule the proxied path already runs
 * (`LlmObservabilityService.bodiesEnabled`), expressed once so the two cannot drift: the
 * inline path having no gate at all — while the proxy path had one — is what let an
 * opted-out workspace keep shipping its inline bodies to Langfuse/OTel
 * (observability-logging-gaps.md, C2). It lives in the shared server layer because that is
 * where BOTH facades assemble the scoped model provider, so wiring it is symmetric by
 * construction rather than a per-runtime obligation to remember.
 *
 * Two `true` answers are deliberate, not lenient defaults:
 *  - **No settings source wired** — defer to the deployment's own `LLM_RECORD_PROMPTS`
 *    switch, exactly as the proxy path does. There is no stored opt-out to honour.
 *  - **No workspace on the call** — an untagged inline call has no workspace whose opt-out
 *    could apply, so the deployment switch alone governs it.
 *
 * A read that THROWS is not handled here: the caller fails closed on it (see
 * `InstrumentedModelProvider.bodiesAllowed`), because an unreadable settings row is not
 * consent.
 */
export function createStoreAgentContextGate(deps: {
  repository?: WorkspaceSettingsRepository
  /**
   * The shared `AppCaches.workspaceSettings` slice, when the facade has one to hand. Absent
   * ⇒ a direct repository read per call. That is the Worker's situation and it costs
   * nothing: `workspaceSettings` is `enabled: false` in the isolate-safe profile (our own
   * mutable state, with no cross-isolate invalidation bus), so the slice would be a
   * pass-through there anyway.
   */
  cache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
}): WorkspaceBodiesGate {
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
