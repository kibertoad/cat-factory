import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { withWorkflowLogExport } from './logExport'

/** Params for a full-repo backfill of one installation. */
interface GitHubBackfillParams {
  installationId: number
}

const STEP_CONFIG = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable full backfill for a GitHub App installation: rediscover its repos and
 * deep-sync each one. Used for the initial connect and explicit `full` resyncs,
 * where doing the work inline could exceed request limits. All business logic
 * lives in core's GitHubSyncService; this just drives it inside a retriable,
 * checkpointed step.
 */
export class GitHubBackfillWorkflow extends WorkflowEntrypoint<Env, GitHubBackfillParams> {
  override async run(
    event: WorkflowEvent<GitHubBackfillParams>,
    step: WorkflowStep,
  ): Promise<void> {
    // Every workflow wake brackets its body this way: the isolate workerd starts it in has had
    // no other entry point apply the logging settings, and gives itself back at each durable
    // suspension. See `./logExport.ts`.
    await withWorkflowLogExport(this.env, step, async (step) => {
      const { installationId } = event.payload
      await step.do(`backfill-${installationId}`, STEP_CONFIG, async () => {
        const github = buildContainer(this.env).github
        if (github) await github.syncService.backfillInstallation(installationId)
      })
    })
  }
}
