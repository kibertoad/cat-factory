import type { EnvironmentTestRunner } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'
import type { EnvironmentTestWorkflowParams } from './EnvironmentTestWorkflow'

/**
 * Drives ephemeral-environment self-test runs durably via Cloudflare Workflows,
 * mirroring WorkflowsEnvConfigRepairRunner. Each run maps to one Workflows instance
 * whose id is the run id, which makes `startRun` idempotent (a duplicate start, or a
 * sweeper re-drive racing a live instance, is tolerated).
 */
export class WorkflowsEnvironmentTestRunner implements EnvironmentTestRunner {
  constructor(private readonly workflow: Workflow) {}

  async startRun(workspaceId: string, id: string): Promise<void> {
    try {
      await this.workflow.create({
        id,
        params: { workspaceId, jobId: id } satisfies EnvironmentTestWorkflowParams,
      })
    } catch {
      // An instance with this id already exists (a duplicate start or a sweeper
      // re-drive racing a live instance). The existing instance is authoritative.
    }
  }

  async cancelRun(_workspaceId: string, id: string): Promise<void> {
    try {
      const instance = await this.workflow.get(id)
      await instance.terminate()
    } catch {
      // No live instance to terminate (already finished/terminated). Nothing to do.
    }
  }
}
