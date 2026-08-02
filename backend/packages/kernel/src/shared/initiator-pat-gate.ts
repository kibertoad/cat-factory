import { DEFAULT_WORKSPACE_SETTINGS } from '../domain/catalog.js'
import { readCachedWorkspaceSettings } from '../ports/caching.js'
import type { GroupCacheHandle, WorkspaceSettingsCacheValue } from '../ports/caching.js'
import type { WorkspaceSettingsRepository } from '../ports/workspace-settings-repositories.js'

/**
 * Whether a workspace permits a RUN to authenticate as its initiator's own personal access
 * token instead of the deployment credential (the App installation token, or local mode's
 * env PAT). Asked once per credential mint on the run path.
 */
export type InitiatorPatGate = (workspaceId: string) => Promise<boolean>

/**
 * The per-workspace `allowInitiatorPat` switch, as ONE factory shared by every mint site —
 * the sibling of {@link createStoreAgentContextGate}, and for the same reason: the rule is
 * asked from three places (the engine's GitHub client via `PatPreferringAppRegistry`, and the
 * container-dispatch mint on each facade), and three copies of it would be three chances for
 * a deployment that opted out to still hand a run an initiator's token.
 *
 * The control it implements is stated in `backend/docs/security-model.md`: an initiator's PAT
 * OUTRANKS the deployment credential on the run path, and its scope is whatever the human who
 * minted it granted — so without this switch the blast radius of a compromised run is a
 * property of whoever started it rather than of how the operator scoped the deployment.
 *
 * `true` when no repository is wired is not a lenient default: with no settings store there is
 * no stored opt-out to honour, which is the situation of a facade that never wired workspace
 * settings at all (tests, a minimal container). A read that THROWS is deliberately NOT handled
 * here — the caller decides, and the one caller
 * ({@link createResolveRunInitiatorToken} in `@cat-factory/server`) fails CLOSED on it, since
 * an unreadable settings row is not permission to widen a run's credential.
 */
export function createInitiatorPatGate(deps: {
  repository?: WorkspaceSettingsRepository
  /**
   * The shared `AppCaches.workspaceSettings` slice when the facade has one. This read runs per
   * dispatch and per gate probe; the slice is invalidated by `WorkspaceSettingsService.update`,
   * so a turned-off switch takes effect on the next run rather than on a TTL. Absent ⇒ a direct
   * repository read (the Worker's situation, where the slice is a pass-through anyway).
   */
  cache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
}): InitiatorPatGate {
  const { repository, cache } = deps
  if (!repository) return () => Promise.resolve(true)
  return async (workspaceId: string): Promise<boolean> => {
    const settings =
      (await readCachedWorkspaceSettings(cache, repository, workspaceId)) ??
      DEFAULT_WORKSPACE_SETTINGS
    return settings.allowInitiatorPat
  }
}
