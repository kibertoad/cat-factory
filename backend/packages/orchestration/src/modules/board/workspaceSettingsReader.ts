import type { WorkspaceSettings } from '@cat-factory/contracts'

/**
 * The minimal read seam over a workspace's runtime settings, shared by every board-service
 * collaborator that needs them (today the review-debt friction guard and the new-service
 * provisioning default). One interface rather than one per consumer: they all read the SAME
 * row through the SAME service, so a second copy would only invite a facade to wire one and
 * forget the other — which fails silently, since every consumer degrades to a pass-through
 * when its reader is absent.
 *
 * Satisfied structurally by `WorkspaceSettingsService`, so wiring is `settings?.service`.
 */
export interface WorkspaceSettingsReader {
  get(workspaceId: string): Promise<WorkspaceSettings>
}
