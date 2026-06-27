import { getKaizenOverviewContract, getKaizenRunGradingsContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Kaizen (post-run grading) read endpoints: the screen overview + a run's gradings. */
export function kaizenApi({ send, ws }: ApiContext) {
  return {
    // The Kaizen screen: recent grading history + the verified-combo library.
    getKaizenOverview: (workspaceId: string) =>
      send(getKaizenOverviewContract, { pathPrefix: ws(workspaceId) }),

    // The gradings recorded for one run (the run-window status surface).
    getKaizenForExecution: (workspaceId: string, executionId: string) =>
      send(getKaizenRunGradingsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),
  }
}
