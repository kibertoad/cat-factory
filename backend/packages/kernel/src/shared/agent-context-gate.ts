import { DEFAULT_WORKSPACE_SETTINGS } from '../domain/catalog.js'
import { readCachedWorkspaceSettings } from '../ports/caching.js'
import type { GroupCacheHandle, WorkspaceSettingsCacheValue } from '../ports/caching.js'
import type { WorkspaceSettingsRepository } from '../ports/workspace-settings-repositories.js'

/**
 * Whether prompt/response BODIES may be captured for a workspace.
 *
 * `null` means the call could not be attributed to a workspace, which is a REFUSAL, not a
 * default-on: an unattributable call is precisely the one whose opt-out cannot be checked,
 * and the failure mode here is exporting a workspace's model exchange after it opted out.
 */
export type StoreAgentContextGate = (workspaceId: string | null) => Promise<boolean>

/**
 * The per-workspace half of the double gate that governs body capture across ALL
 * observability paths: the deployment-wide `LLM_RECORD_PROMPTS` switch AND the workspace's
 * own `storeAgentContext` toggle, the operator opt-out winning.
 *
 * It is a shared factory rather than a method on each service because the two paths DID
 * diverge: the proxy path (`LlmObservabilityService`) consulted both, while the inline path
 * (`InstrumentedModelProvider`, feeding Langfuse/OTel for judges, consensus, the requirements
 * writer and every other inline kind) honoured only the deployment switch — so a workspace
 * that had explicitly opted out still shipped its inline prompt and response bodies to an
 * external trace backend. That is a privacy defect, not a coverage gap
 * (observability-logging-gaps.md, C2).
 *
 * With no settings repository wired there is no per-workspace opinion to consult, so the
 * gate defers to the deployment switch and returns true.
 */
export function createStoreAgentContextGate(deps: {
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * The shared `AppCaches.workspaceSettings` slice. This read runs per recorded call, so
   * caching it (invalidated by `WorkspaceSettingsService.update`) avoids a DB read per call.
   */
  workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
}): StoreAgentContextGate {
  const repository = deps.workspaceSettingsRepository
  if (!repository) return async () => true
  return async (workspaceId) => {
    if (workspaceId === null) return false
    const settings =
      (await readCachedWorkspaceSettings(deps.workspaceSettingsCache, repository, workspaceId)) ??
      DEFAULT_WORKSPACE_SETTINGS
    return settings.storeAgentContext
  }
}
