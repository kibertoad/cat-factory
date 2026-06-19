import type { WorkRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss } from 'pg-boss'
import { type DriveConfig, driveExecution } from './drive.js'

// Durable execution on pg-boss: the analogue of the Worker's Cloudflare Workflows
// driver. `startRun` enqueues an advance job (deduped per run via singletonKey); a
// registered worker drives the run to a standstill via `driveExecution`. A resolved
// decision re-enqueues an advance to resume a parked run. State lives in Postgres,
// so a crash mid-run is recovered by re-enqueueing (e.g. the cron stale-run sweep).

const QUEUE = 'execution.advance'

interface AdvanceJob {
  workspaceId: string
  executionId: string
}

export class PgBossWorkRunner implements WorkRunner {
  constructor(private readonly boss: PgBoss) {}

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    await this.boss.send(QUEUE, { workspaceId, executionId }, { singletonKey: executionId })
  }

  async signalDecision(
    workspaceId: string,
    executionId: string,
    _decisionId: string,
    _choice: string,
  ): Promise<void> {
    // The decision is already persisted by resolveDecision; re-enqueue an advance so
    // the parked run resumes. The DB write is the source of truth either way.
    await this.boss.send(QUEUE, { workspaceId, executionId }, { singletonKey: executionId })
  }

  async cancelRun(_workspaceId: string, _executionId: string): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; any in-flight
    // advance job is a no-op once the run is terminal (advanceInstance returns noop).
  }
}

/** Create the execution queue and start the worker that drives runs. */
export async function startExecutionWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  await boss.createQueue(QUEUE)
  await boss.work<AdvanceJob>(QUEUE, async (jobs: Job<AdvanceJob>[]) => {
    for (const job of jobs) {
      const { workspaceId, executionId } = job.data
      try {
        await driveExecution(container.executionService, workspaceId, executionId, cfg, log)
      } catch (error) {
        log.error(
          { workspaceId, executionId, err: error instanceof Error ? error.message : String(error) },
          'execution driver failed',
        )
        throw error
      }
    }
  })
}
