import {
  decodeNotificationRoutingMatrix,
  isNotificationRouted,
  type NotificationSettings,
} from '@cat-factory/contracts'
import type {
  Clock,
  NotificationDeliveryChannel,
  NotificationRouter,
  NotificationRoutingMatrix,
  NotificationSettingsRepository,
  NotificationType,
} from '@cat-factory/kernel'

// The NOTIFICATION MANAGER: a workspace's per-type, per-channel routing, and the
// {@link NotificationRouter} the delivery path asks. One service owns both halves so the
// answer the settings surface renders and the answer the engine acts on cannot come from
// two different readings of the same row.
//
// The stored matrix is a sparse map of OVERRIDES; the resolution (override, else the
// shipped default) lives in `@cat-factory/contracts` because the SPA has to state the same
// thing. Nothing here re-derives it.

export interface NotificationSettingsServiceDependencies {
  notificationSettingsRepository: NotificationSettingsRepository
  clock: Clock
}

export class NotificationSettingsService implements NotificationRouter {
  constructor(private readonly deps: NotificationSettingsServiceDependencies) {}

  /** A workspace's settings; the empty matrix (everything on its default) when unconfigured. */
  async get(workspaceId: string): Promise<NotificationSettings> {
    const record = await this.deps.notificationSettingsRepository.getByWorkspace(workspaceId)
    if (!record) return { matrix: {}, updatedAt: 0 }
    return { matrix: this.parseMatrix(record.matrixJson), updatedAt: record.updatedAt }
  }

  /** Replace a workspace's routing overrides (a full replace, like the Slack routing write). */
  async update(
    workspaceId: string,
    matrix: NotificationRoutingMatrix,
  ): Promise<NotificationSettings> {
    const updatedAt = this.deps.clock.now()
    await this.deps.notificationSettingsRepository.upsert({
      workspaceId,
      matrixJson: JSON.stringify(matrix),
      updatedAt,
    })
    return { matrix, updatedAt }
  }

  /**
   * The routing decision, for one delivery. One point read per notification per routed
   * channel: notifications are raised at human scale (a run parks, a gate gives up), so
   * this is not on any hot path, and a cached copy would answer with a mute the operator
   * had already lifted.
   */
  async isRouted(
    workspaceId: string,
    type: NotificationType,
    channel: NotificationDeliveryChannel,
  ): Promise<boolean> {
    const { matrix } = await this.get(workspaceId)
    return isNotificationRouted(matrix, type, channel)
  }

  /**
   * Decode a stored matrix. The cell-by-cell tolerance (a retired type costs its own override
   * and nothing else) lives in `@cat-factory/contracts` beside the resolution it feeds, so the
   * settings UI decoding the same row reaches the same answer.
   */
  private parseMatrix(matrixJson: string): NotificationRoutingMatrix {
    try {
      return decodeNotificationRoutingMatrix(JSON.parse(matrixJson))
    } catch {
      // A corrupt row is, for routing, the same state as an unconfigured one: every cell falls
      // back to its shipped default. Throwing here would run on the delivery path.
      return {}
    }
  }
}
