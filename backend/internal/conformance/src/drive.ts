import { type DriveConfig, driveExecution } from '@cat-factory/orchestration'
import type { ExecutionInstance } from '@cat-factory/kernel'

// `driveExecution`'s first parameter is the orchestration `ExecutionService`; deriving
// the type here avoids importing the (heavy) class just for the harness signature.
type ExecutionService = Parameters<typeof driveExecution>[0]

/**
 * Instant polls (no real waiting) + generous budgets, for the suite's deterministic
 * fake agents. The fakes finish a job in a poll or two, so the cadence is irrelevant —
 * only the budget ceilings matter, kept well above any fixture's step/fix count.
 */
export const CONFORMANCE_DRIVE_CONFIG: DriveConfig = {
  jobPollIntervalMs: 0,
  jobMaxPolls: 500,
  jobPollFailureTolerance: 3,
  ciPollIntervalMs: 0,
  ciMaxPolls: 500,
}

const noWait = (): Promise<void> => Promise.resolve()

/**
 * Drive every active run in a workspace to a standstill through the REAL production
 * per-run driver (`driveExecution` from `@cat-factory/orchestration`), with instant
 * sleeps. BOTH facade harnesses (Cloudflare over D1, Node over Postgres) call this, so
 * the conformance suite exercises the production advance/poll/fail loop rather than a
 * hand-rolled copy that can silently diverge from it — the per-run driving logic is
 * runtime-neutral and identical across facades; only persistence differs.
 *
 * The outer round loop stands in for the runtime's job scheduler (pg-boss / Cloudflare
 * Workflows + the stale-run sweeper): it re-drives any run a previous round left
 * `running`/`paused` — a resumed spend pause, a freshly dispatched gate-fixer — until
 * nothing is active.
 */
export async function driveWorkspace(
  exec: ExecutionService,
  workspaceId: string,
  listExecutions: () => Promise<ExecutionInstance[]>,
  maxRounds = 50,
): Promise<ExecutionInstance[]> {
  for (let round = 0; round < maxRounds; round++) {
    const active = (await listExecutions()).filter(
      (e) => e.status === 'running' || e.status === 'paused',
    )
    if (active.length === 0) break
    for (const e of active) {
      await driveExecution(exec, workspaceId, e.id, CONFORMANCE_DRIVE_CONFIG, { sleep: noWait })
    }
  }
  return listExecutions()
}
