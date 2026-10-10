import { GUIDED_REVIEW_MAX_PASSES, type GuidedReviewJob } from '@cat-factory/kernel'
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { withWorkflowLogExport } from './logExport'
import { buildWorkflowRuntime } from './runtime'

/** Params passed to a GuidedReviewWorkflow instance. */
export interface GuidedReviewWorkflowParams {
  workspaceId: string
  job: GuidedReviewJob
}

/**
 * A retry re-runs `runJob`, whose claim makes it a no-op while the first attempt's lease holds; the
 * cron re-drive takes the job back over once the lease lapses.
 */
const STEP_CONFIG = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
} satisfies WorkflowStepConfig

/** Durable driver for one guided-review job: generating an overview or one assistant message. */
export class GuidedReviewWorkflow extends WorkflowEntrypoint<Env, GuidedReviewWorkflowParams> {
  override run(
    event: WorkflowEvent<GuidedReviewWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    return withWorkflowLogExport(this.env, step, (step) => this.drive(event.payload, step))
  }

  private async drive(params: GuidedReviewWorkflowParams, step: WorkflowStep): Promise<void> {
    const container = await buildWorkflowRuntime(
      () => buildContainer(this.env),
      step,
      'guided-review',
    )
    // One short step per pass with a durable sleep between them: a deep answer's container lives
    // outside the Workflow, which only waits between polls.
    for (let pass = 0; pass < GUIDED_REVIEW_MAX_PASSES; pass++) {
      const progress = await step.do(`run-${pass}`, STEP_CONFIG, async () => {
        const service = container.guidedReview?.service
        return service ? service.runJob(params.workspaceId, params.job) : { done: true as const }
      })
      if (progress.done) return
      await step.sleep(`wait-${pass}`, progress.pollAfterMs)
    }
  }
}
