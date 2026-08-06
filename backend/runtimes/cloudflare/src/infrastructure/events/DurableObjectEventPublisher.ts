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
import {
  type BoardChange,
  boardWireEvent,
  bootstrapWireEvent,
  describeError,
  type ExecutionEventPublisher,
  type InfraSetupTransition,
} from '@cat-factory/kernel'
import { logger } from '../observability/logger'
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

  /**
   * Publishes stay best-effort, but no longer SILENT. A persistently-broken hub — a DO that
   * throws on every fetch, a serialisation error on a new event shape — used to leave every
   * browser stale with zero log lines, indistinguishable from "nobody is watching this board".
   * `warn`, not `error`: the DB write is authoritative and the client's reconnect-resync
   * recovers, so this degrades the UI's liveness, it does not lose work.
   */
  private readonly log = logger.child({ publisher: 'durable-object' })

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

  async boardChanged(workspaceId: string, change: BoardChange): Promise<void> {
    // The wire shape (above all WHICH payloads may ride) is assembled by the shared kernel
    // builder, so this facade and its Node twin cannot drift. `originConnectionId` stays a
    // side-channel argument: it tells the hub which socket to skip, and the wire event itself is
    // identical for every client that does receive it.
    await this.publish(workspaceId, boardWireEvent(change, Date.now()), change.originConnectionId)
  }

  async bootstrapChanged(
    workspaceId: string,
    job: BootstrapJob,
    block?: Block | null,
  ): Promise<void> {
    await this.publish(workspaceId, bootstrapWireEvent(job, block, Date.now()))
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

  async infraSetupChanged(workspaceId: string, change: InfraSetupTransition): Promise<void> {
    await this.publish(workspaceId, { type: 'infraSetup', ...change, at: Date.now() })
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
    } catch (error) {
      this.log.warn('realtime publish failed; browsers may be stale until they resync', {
        workspaceId,
        eventType: event.type,
        ...describeError(error),
      })
    }
  }
}
