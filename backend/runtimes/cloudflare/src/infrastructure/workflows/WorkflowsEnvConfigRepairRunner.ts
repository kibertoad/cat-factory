import type { EnvConfigRepairRunner } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'
import type { EnvConfigRepairWorkflowParams } from './EnvConfigRepairWorkflow'

/**
 * Drives environment-provider config-repair runs durably via Cloudflare Workflows,
 * mirroring WorkflowsBootstrapRunner. Each run maps to one Workflows instance whose id
 * is the repair job id, which makes `startRun` idempotent (a duplicate start, or a
 * sweeper re-drive racing a live instance, is tolerated).
 */
export class WorkflowsEnvConfigRepairRunner implements EnvConfigRepairRunner {
  constructor(private readonly workflow: Workflow) {}

  async startRun(workspaceId: string, jobId: string): Promise<void> {
    try {
      await this.workflow.create({
        id: jobId,
        params: { workspaceId, jobId } satisfies EnvConfigRepairWorkflowParams,
      })
    } catch {
      // An instance with this id already exists (a duplicate start or a sweeper
      // re-drive racing a live instance). The existing instance is authoritative.
    }
  }

  async cancelRun(_workspaceId: string, jobId: string): Promise<void> {
    try {
      const instance = await this.workflow.get(jobId)
      await instance.terminate()
    } catch {
      // No live instance to terminate (already finished/terminated). Nothing to do.
    }
  }
}
