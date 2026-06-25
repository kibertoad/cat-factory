import type { ExecutionInstance } from '~/types/domain'
import type { ApiContext } from './context'

/**
 * The human-testing gate's run-driving actions. Each acts on the block's parked `human-test`
 * step and returns the updated execution instance (the gate state rides on its current step,
 * and also arrives live via the execution stream).
 */
export function humanTestApi({ http, ws }: ApiContext) {
  const base = (workspaceId: string, blockId: string) =>
    `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/human-test`

  return {
    // Confirm the change works: tear the env down and advance the pipeline.
    confirmHumanTest: (workspaceId: string, blockId: string) =>
      http<ExecutionInstance>(`${base(workspaceId, blockId)}/confirm`, { method: 'POST' }),

    // Submit findings and request a fix (dispatches the Tester's fixer, then rebuilds the env).
    requestHumanTestFix: (workspaceId: string, blockId: string, findings: string) =>
      http<ExecutionInstance>(`${base(workspaceId, blockId)}/request-fix`, {
        method: 'POST',
        body: { findings },
      }),

    // Pull latest main into the PR branch + redeploy (conflict → conflict-resolver).
    pullMainHumanTest: (workspaceId: string, blockId: string) =>
      http<ExecutionInstance>(`${base(workspaceId, blockId)}/pull-main`, { method: 'POST' }),

    // Rebuild the ephemeral environment on demand.
    recreateHumanTestEnv: (workspaceId: string, blockId: string) =>
      http<ExecutionInstance>(`${base(workspaceId, blockId)}/recreate-env`, { method: 'POST' }),

    // Destroy the ephemeral environment on demand (the run stays parked).
    destroyHumanTestEnv: (workspaceId: string, blockId: string) =>
      http<ExecutionInstance>(`${base(workspaceId, blockId)}/destroy-env`, { method: 'POST' }),
  }
}
