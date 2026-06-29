import type {
  Block,
  BootstrapJob,
  BrainstormSession,
  ConsensusSession,
  ClarityReview,
  EnvConfigRepairJob,
  ExecutionEventPublisher,
  ExecutionInstance,
  LlmCallActivity,
  Notification,
  RequirementReview,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'

export interface FanOutEventPublisherDependencies {
  workspaceMountRepository: Pick<WorkspaceMountRepository, 'listWorkspaceIdsMountingBlock'>
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
    // Single join (block → its service → the workspaces mounting it). Empty when the block has
    // no service, so the result collapses to the origin only.
    const mounting = await this.deps.workspaceMountRepository.listWorkspaceIdsMountingBlock(
      originWorkspaceId,
      blockId,
    )
    return [...new Set([originWorkspaceId, ...mounting])]
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

  async boardChanged(
    workspaceId: string,
    reason: string,
    blockId?: string | null,
    originConnectionId?: string | null,
  ): Promise<void> {
    // A structural change to a shared service (a module materialised, a run cancelled, a
    // bootstrap finished) must prompt a refresh on EVERY board that mounts it. When the caller
    // names a block of the affected service we resolve it to that set; a genuinely block-less
    // signal falls back to the originating workspace only.
    for (const ws of await this.targets(workspaceId, blockId)) {
      await this.inner.boardChanged(ws, reason, blockId, originConnectionId)
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

  // A repair run has no board block, so there's no shared-service fan-out — it is purely
  // workspace-scoped. Forward straight to the inner publisher for this workspace.
  async envConfigRepairChanged(workspaceId: string, job: EnvConfigRepairJob): Promise<void> {
    await this.inner.envConfigRepairChanged?.(workspaceId, job)
  }

  async notificationChanged(workspaceId: string, notification: Notification): Promise<void> {
    for (const ws of await this.targets(workspaceId, notification.blockId)) {
      await this.inner.notificationChanged?.(ws, notification)
    }
  }

  async llmCallObserved(workspaceId: string, activity: LlmCallActivity): Promise<void> {
    // The compact activity carries no block id, so there is nothing to resolve a shared
    // service from — deliver to the originating workspace only. Model activity for a
    // mounted service surfacing solely on its origin board is an acceptable edge; the
    // persisted metrics (and the panel's lazy load) remain the cross-workspace source.
    await this.inner.llmCallObserved?.(workspaceId, activity)
  }

  async requirementReviewChanged(workspaceId: string, review: RequirementReview): Promise<void> {
    for (const ws of await this.targets(workspaceId, review.blockId)) {
      await this.inner.requirementReviewChanged?.(ws, review)
    }
  }

  async consensusSessionChanged(workspaceId: string, session: ConsensusSession): Promise<void> {
    for (const ws of await this.targets(workspaceId, session.blockId)) {
      await this.inner.consensusSessionChanged?.(ws, session)
    }
  }

  async clarityReviewChanged(workspaceId: string, review: ClarityReview): Promise<void> {
    for (const ws of await this.targets(workspaceId, review.blockId)) {
      await this.inner.clarityReviewChanged?.(ws, review)
    }
  }

  async brainstormSessionChanged(workspaceId: string, session: BrainstormSession): Promise<void> {
    for (const ws of await this.targets(workspaceId, session.blockId)) {
      await this.inner.brainstormSessionChanged?.(ws, session)
    }
  }
}
