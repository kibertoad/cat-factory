import { guidedReviewJobKey } from '@cat-factory/kernel'
import type { GuidedReviewJob, GuidedReviewRunner } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'
import type { GuidedReviewWorkflowParams } from './GuidedReviewWorkflow'

/**
 * Drives guided-review jobs through Cloudflare Workflows. Each start creates a fresh instance:
 * a finished instance id cannot be reused, and the job's own claim already makes a duplicate
 * delivery a no-op.
 */
export class WorkflowsGuidedReviewRunner implements GuidedReviewRunner {
  constructor(
    private readonly workflow: Workflow,
    private readonly now: () => number = Date.now,
  ) {}

  async start(workspaceId: string, job: GuidedReviewJob): Promise<void> {
    await this.workflow.create({
      id: `${guidedReviewJobKey(job)}-${this.now()}`,
      params: { workspaceId, job } satisfies GuidedReviewWorkflowParams,
    })
  }
}
