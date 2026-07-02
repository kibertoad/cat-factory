import type { WorkRunner } from '@cat-factory/kernel'
import type { Queue, Workflow } from '@cloudflare/workers-types'
import type { ExecutionStartMessage } from '../env'

/** Params passed to a Workflows instance; also the queue message shape. */
export interface ExecutionWorkflowParams {
  workspaceId: string
  executionId: string
}

export interface WorkflowsWorkRunnerDeps {
  workflow: Workflow
  /** When present, runs are started via the queue (admission rate limiting). */
  queue?: Queue<ExecutionStartMessage>
}

/**
 * Drives runs durably via Cloudflare Workflows. Each run maps to one Workflows
 * instance whose id is the execution id, which makes start idempotent and lets
 * decisions/cancels address the instance directly. When a queue is configured,
 * `startRun` enqueues instead of creating directly so the consumer's
 * `max_concurrency` bounds how fast runs are kicked off.
 */
export class WorkflowsWorkRunner implements WorkRunner {
  private readonly workflow: Workflow
  private readonly queue?: Queue<ExecutionStartMessage>

  constructor({ workflow, queue }: WorkflowsWorkRunnerDeps) {
    this.workflow = workflow
    this.queue = queue
  }

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    if (this.queue) {
      await this.queue.send({ workspaceId, executionId })
      return
    }
    await this.create(workspaceId, executionId)
  }

  /** Create the Workflows instance, tolerating an existing one (idempotent). */
  async create(workspaceId: string, executionId: string): Promise<void> {
    try {
      await this.workflow.create({
        id: executionId,
        params: { workspaceId, executionId } satisfies ExecutionWorkflowParams,
      })
    } catch {
      // An instance with this id already exists (a duplicate start or a sweeper
      // re-drive racing a live instance). The existing instance is authoritative.
    }
  }

  async signalDecision(
    _workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<void> {
    try {
      const instance = await this.workflow.get(executionId)
      await instance.sendEvent({ type: `decision-${decisionId}`, payload: { choice } })
    } catch {
      // No live instance to signal (tick fallback / already finished). The DB
      // write in resolveDecision remains the source of truth.
    }
  }

  async signalResume(_workspaceId: string, executionId: string): Promise<void> {
    try {
      const instance = await this.workflow.get(executionId)
      // Wake the paused run's `waitForEvent('spend-resume-*')` so it re-advances now instead of
      // waiting out the periodic budget re-check. The event type is fixed (one pause per run).
      await instance.sendEvent({ type: 'spend-resume', payload: {} })
    } catch {
      // No live instance to wake (already resumed / finished). The DB flip to `running` in
      // resumePaused is the source of truth; the instance picks it up on its next re-check.
    }
  }

  async cancelRun(_workspaceId: string, executionId: string): Promise<void> {
    try {
      const instance = await this.workflow.get(executionId)
      await instance.terminate()
    } catch {
      // Nothing live to cancel.
    }
  }
}
