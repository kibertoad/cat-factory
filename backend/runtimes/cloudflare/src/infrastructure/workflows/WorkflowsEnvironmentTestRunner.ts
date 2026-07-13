import type { EnvironmentTestRunner } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'
import type { EnvironmentTestWorkflowParams } from './EnvironmentTestWorkflow'
import { logger } from '../observability/logger'

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
    } catch (error) {
      // Usually an instance with this id already exists (a duplicate start or a sweeper
      // re-drive racing a live instance) — the existing instance is authoritative. Log it
      // regardless: a GENUINE create failure (rate limit, outage) strands the run until
      // the cron env-test sweep re-drives it, and this line is the only trace of why.
      logger.warn(
        { workspaceId, runId: id, err: error instanceof Error ? error.message : String(error) },
        'env-test workflow create was rejected; relying on the existing instance or the sweeper',
      )
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
