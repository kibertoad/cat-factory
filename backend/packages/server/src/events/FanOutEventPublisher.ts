import type {
  Block,
  BlockRepository,
  BootstrapJob,
  ExecutionEventPublisher,
  ExecutionInstance,
  Notification,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'

export interface FanOutEventPublisherDependencies {
  blockRepository: Pick<BlockRepository, 'serviceIdOf'>
  workspaceMountRepository: Pick<WorkspaceMountRepository, 'listByService'>
}

/**
 * In-org real-time fan-out. A shared service can appear on several workspaces' boards, so
 * a live change to it (run progress, bootstrap, notification) must reach EVERY board that
 * mounts the service — not just the workspace the engine happens to address. This decorator
 * resolves the changed block's service, expands it to the set of mounting workspaces, and
 * re-publishes the event to each via the inner per-workspace publisher.
 *
 * Best-effort like the inner publisher: the persisted row is the source of truth, so a
 * client reconciles any miss by re-fetching its snapshot. When a block can't be resolved to
 * a service (e.g. a legacy workspace-local block, or a coarse `boardChanged` with no block)
 * it falls back to delivering to the originating workspace only.
 */
export class FanOutEventPublisher implements ExecutionEventPublisher {
  constructor(
    private readonly inner: ExecutionEventPublisher,
    private readonly deps: FanOutEventPublisherDependencies,
  ) {}

  /** The set of workspaces a change to `blockId` should reach: the origin + every mount. */
  private async targets(originWorkspaceId: string, blockId?: string | null): Promise<string[]> {
    if (!blockId) return [originWorkspaceId]
    const serviceId = await this.deps.blockRepository.serviceIdOf(originWorkspaceId, blockId)
    if (!serviceId) return [originWorkspaceId]
    const mounts = await this.deps.workspaceMountRepository.listByService(serviceId)
    return [...new Set([originWorkspaceId, ...mounts.map((m) => m.workspaceId)])]
  }

  async executionChanged(
    workspaceId: string,
    instance: ExecutionInstance,
    block?: Block | null,
  ): Promise<void> {
    for (const ws of await this.targets(workspaceId, block?.id ?? instance.blockId)) {
      await this.inner.executionChanged(ws, instance, block)
    }
  }

  async boardChanged(workspaceId: string, reason: string, blockId?: string | null): Promise<void> {
    // A structural change to a shared service (a module materialised, a run cancelled, a
    // bootstrap finished) must prompt a refresh on EVERY board that mounts it. When the caller
    // names a block of the affected service we resolve it to that set; a genuinely block-less
    // signal falls back to the originating workspace only.
    for (const ws of await this.targets(workspaceId, blockId)) {
      await this.inner.boardChanged(ws, reason, blockId)
    }
  }

  async bootstrapChanged(
    workspaceId: string,
    job: BootstrapJob,
    block?: Block | null,
  ): Promise<void> {
    for (const ws of await this.targets(workspaceId, block?.id ?? job.blockId)) {
      await this.inner.bootstrapChanged?.(ws, job, block)
    }
  }

  async notificationChanged(workspaceId: string, notification: Notification): Promise<void> {
    for (const ws of await this.targets(workspaceId, notification.blockId)) {
      await this.inner.notificationChanged?.(ws, notification)
    }
  }
}
