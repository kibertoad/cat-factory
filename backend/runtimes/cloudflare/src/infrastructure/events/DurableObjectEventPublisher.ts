import type {
  BrainstormSession,
  Block,
  BootstrapJob,
  ConsensusSession,
  ClarityReview,
  DocInterviewSession,
  EnvConfigRepairJob,
  EnvironmentTestRun,
  ExecutionInstance,
  Initiative,
  KaizenGrading,
  LlmCallActivity,
  Notification,
  RequirementReview,
  WorkspaceEvent,
} from '@cat-factory/contracts'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { WorkspaceEventsHub } from '../durable-objects/WorkspaceEventsHub'

/**
 * Publishes execution/board events to the per-workspace {@link WorkspaceEventsHub}
 * Durable Object, which fans them out to subscribed browsers. Best-effort: a
 * failure here (no live hub, transient DO error) must never break a state
 * transition, so every publish swallows its own errors — the persisted run remains
 * the source of truth, and a client reconciles missed events on reconnect.
 */
export class DurableObjectEventPublisher implements ExecutionEventPublisher {
  constructor(private readonly namespace: DurableObjectNamespace<WorkspaceEventsHub>) {}

  async executionChanged(
    workspaceId: string,
    instance: ExecutionInstance,
    block?: Block | null,
  ): Promise<void> {
    await this.publish(workspaceId, {
      type: 'execution',
      instance,
      block: block ?? null,
      at: Date.now(),
    })
  }

  async boardChanged(
    workspaceId: string,
    reason: string,
    _blockId?: string | null,
    originConnectionId?: string | null,
  ): Promise<void> {
    // `_blockId` is used by the FanOutEventPublisher decorator to resolve which workspaces a
    // shared service's change reaches; the per-workspace publish itself is block-agnostic.
    // `originConnectionId` (when present) rides as a side-channel header so the hub can skip
    // the socket that caused the change — the wire event stays identical across all clients.
    await this.publish(workspaceId, { type: 'board', reason, at: Date.now() }, originConnectionId)
  }

  async bootstrapChanged(
    workspaceId: string,
    job: BootstrapJob,
    block?: Block | null,
  ): Promise<void> {
    await this.publish(workspaceId, {
      type: 'bootstrap',
      job,
      block: block ?? null,
      at: Date.now(),
    })
  }

  async envConfigRepairChanged(workspaceId: string, job: EnvConfigRepairJob): Promise<void> {
    await this.publish(workspaceId, { type: 'env-config-repair', job, at: Date.now() })
  }

  async envTestChanged(workspaceId: string, run: EnvironmentTestRun): Promise<void> {
    await this.publish(workspaceId, { type: 'envTest', run, at: Date.now() })
  }

  async notificationChanged(workspaceId: string, notification: Notification): Promise<void> {
    await this.publish(workspaceId, { type: 'notification', notification, at: Date.now() })
  }

  async llmCallObserved(workspaceId: string, activity: LlmCallActivity): Promise<void> {
    await this.publish(workspaceId, { type: 'llmCall', call: activity, at: Date.now() })
  }

  async requirementReviewChanged(workspaceId: string, review: RequirementReview): Promise<void> {
    await this.publish(workspaceId, { type: 'requirements', review, at: Date.now() })
  }

  async consensusSessionChanged(workspaceId: string, session: ConsensusSession): Promise<void> {
    await this.publish(workspaceId, { type: 'consensus', session, at: Date.now() })
  }

  async clarityReviewChanged(workspaceId: string, review: ClarityReview): Promise<void> {
    await this.publish(workspaceId, { type: 'clarity', review, at: Date.now() })
  }

  async brainstormSessionChanged(workspaceId: string, session: BrainstormSession): Promise<void> {
    await this.publish(workspaceId, { type: 'brainstorm', session, at: Date.now() })
  }

  async kaizenGradingChanged(workspaceId: string, grading: KaizenGrading): Promise<void> {
    await this.publish(workspaceId, { type: 'kaizen', grading, at: Date.now() })
  }

  async initiativeChanged(workspaceId: string, initiative: Initiative): Promise<void> {
    await this.publish(workspaceId, { type: 'initiative', initiative, at: Date.now() })
  }

  async docInterviewChanged(workspaceId: string, session: DocInterviewSession): Promise<void> {
    await this.publish(workspaceId, { type: 'docInterview', session, at: Date.now() })
  }

  private async publish(
    workspaceId: string,
    event: WorkspaceEvent,
    originConnectionId?: string | null,
  ): Promise<void> {
    try {
      const stub = this.namespace.get(this.namespace.idFromName(workspaceId))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      // The hub drops this event for the socket whose `?cid=` matches, so the connection
      // that triggered the change never refreshes off its own echo.
      if (originConnectionId) headers['X-Origin-Cid'] = originConnectionId
      await stub.fetch('http://hub/publish', {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      })
    } catch {
      // No subscribers / transient DO error — the DB write is authoritative and
      // the client's reconnect-resync covers any missed event.
    }
  }
}
