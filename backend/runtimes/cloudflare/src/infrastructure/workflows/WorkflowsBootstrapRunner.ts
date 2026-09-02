import type { BootstrapRunner } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'
import type { BootstrapWorkflowParams } from './BootstrapWorkflow'

/**
 * Drives "bootstrap repo" runs durably via Cloudflare Workflows, mirroring
 * WorkflowsWorkRunner for pipeline runs. Each DRIVE maps to one Workflows instance whose id is
 * the run's `driveId`, which makes `startRun` idempotent (a duplicate start, or a sweeper
 * re-drive racing a live instance, is tolerated).
 *
 * The instance id is the drive key rather than the run id because a Workflows instance id
 * cannot be recreated once its instance has gone terminal, and a monorepo bootstrap is driven
 * TWICE: once for the survey that parks on a human review, and once for the apply that review
 * releases. Keying on the run would make the second `create` a permanent no-op, leaving an
 * approved bootstrap that never writes anything. `driveId === jobId` for a single-drive run, so
 * every plain bootstrap keeps exactly the instance id it had.
 */
export class WorkflowsBootstrapRunner implements BootstrapRunner {
  constructor(private readonly workflow: Workflow) {}

  async startRun(workspaceId: string, jobId: string, driveId: string): Promise<void> {
    try {
      await this.workflow.create({
        id: driveId,
        params: { workspaceId, jobId } satisfies BootstrapWorkflowParams,
      })
    } catch {
      // An instance with this id already exists (a duplicate start or a sweeper
      // re-drive racing a live instance). The existing instance is authoritative.
    }
  }

  async cancelRun(_workspaceId: string, driveId: string): Promise<void> {
    try {
      const instance = await this.workflow.get(driveId)
      await instance.terminate()
    } catch {
      // No live instance to terminate (already finished/terminated). Nothing to do.
    }
  }
}
