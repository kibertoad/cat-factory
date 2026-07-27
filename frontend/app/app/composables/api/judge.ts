import { getJudgeDecisionContract, resolveJudgeContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * JUDGE steps (the fourth step-taxonomy bucket): a rubric scores the run's work and, when the
 * verdict misses the task's threshold, the run parks. These endpoints read the verdict and
 * resolve the park — proceed anyway, bounce the work back to the producing step for rework, or
 * stop the run. The read returns null when no step carries judge state.
 */
export function judgeApi({ send, ws }: ApiContext) {
  return {
    // The live judge state for a run (null when no step carries one).
    getJudgeState: (workspaceId: string, executionId: string) =>
      send(getJudgeDecisionContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),

    // Resolve a parked verdict: proceed / bounce for rework / stop the run.
    resolveJudge: (
      workspaceId: string,
      executionId: string,
      body: { choice: 'proceed' | 'bounce' | 'stop'; feedback?: string | null },
    ) =>
      send(resolveJudgeContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),
  }
}
