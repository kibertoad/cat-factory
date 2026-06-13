import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { AdvanceResult } from '@cat-factory/core'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import type { ExecutionWorkflowParams } from './WorkflowsWorkRunner'

/** Per-step retry policy: failures retry a few times before the run is failed. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable driver for one pipeline run. It contains NO business logic — every
 * decision lives in core's ExecutionService. Each loop iteration advances the
 * run by exactly one agent step inside a retriable, checkpointed `step.do`, then
 * either loops, parks on a human decision via `waitForEvent`, or stops. Because
 * each committed step is memoised, a crash and replay never re-issues an
 * already-completed LLM call.
 */
export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
  override async run(
    event: WorkflowEvent<ExecutionWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { workspaceId, executionId } = event.payload
    const decisionTimeout = loadConfig(this.env).execution.decisionTimeout as WorkflowSleepDuration

    for (let i = 0; ; i++) {
      let result: AdvanceResult
      try {
        result = (await step.do(`advance-${i}`, STEP_CONFIG, () =>
          buildContainer(this.env).executionService.advanceInstance(workspaceId, executionId, {
            rethrowAgentErrors: true,
          }),
        )) as AdvanceResult
      } catch (error) {
        // Retries exhausted: persist the failure and open the block for review.
        const message = error instanceof Error ? error.message : String(error)
        await step.do(`fail-${i}`, () =>
          buildContainer(this.env).executionService.failRun(workspaceId, executionId, message),
        )
        return
      }

      // 'paused' means the spend budget is exhausted: stop driving this run.
      // The /spend/resume endpoint re-creates the workflow once it frees up.
      if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return

      if (result.kind === 'awaiting_decision') {
        const decisionId = result.decisionId
        try {
          await step.waitForEvent(`await-${decisionId}`, {
            type: `decision-${decisionId}`,
            timeout: decisionTimeout,
          })
        } catch {
          // No human resolved the decision in time — expire for later review.
          await step.do(`expire-${decisionId}`, () =>
            buildContainer(this.env).executionService.failRun(
              workspaceId,
              executionId,
              'Decision timed out awaiting a human response',
            ),
          )
          return
        }
      }
      // 'continue' or a resolved decision: loop and advance the next step.
    }
  }
}
