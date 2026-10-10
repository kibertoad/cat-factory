import type { NotificationRoutingMatrix } from '../domain/types.js'

// Persistence port for the notification manager: a workspace's per-type, per-channel
// routing overrides. One row per workspace, no secrets, edited from a settings surface
// (never written by the engine) — the same shape as `SlackSettingsRepository`, which is
// the neighbour to copy when adding to it.
//
// The matrix is stored as JSON because it is a sparse map of OVERRIDES over the shipped
// defaults (see `@cat-factory/contracts`' `isNotificationRouted`): a column per (type,
// channel) would have to be migrated every time either vocabulary gains a member, and the
// row would then state `false` for a cell no human ever chose.

export interface NotificationSettingsRecord {
  workspaceId: string
  /** The {@link NotificationRoutingMatrix}, serialized as JSON. */
  matrixJson: string
  updatedAt: number
}

export interface NotificationSettingsRepository {
  /** A workspace's routing overrides, or null when it has never configured any. */
  getByWorkspace(workspaceId: string): Promise<NotificationSettingsRecord | null>
  /** Create or replace a workspace's routing overrides. */
  upsert(record: NotificationSettingsRecord): Promise<void>
}

/** Re-exported for repository implementations that map the persisted matrix. */
export type { NotificationRoutingMatrix }
