import type { KaizenGrading, KaizenOverview } from '~/types/domain'
import type { ApiContext } from './context'

/** Kaizen (post-run grading) read endpoints: the screen overview + a run's gradings. */
export function kaizenApi({ http, ws }: ApiContext) {
  return {
    // The Kaizen screen: recent grading history + the verified-combo library.
    getKaizenOverview: (workspaceId: string) => http<KaizenOverview>(`${ws(workspaceId)}/kaizen`),

    // The gradings recorded for one run (the run-window status surface).
    getKaizenForExecution: (workspaceId: string, executionId: string) =>
      http<{ gradings: KaizenGrading[] }>(
        `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/kaizen`,
      ),
  }
}
