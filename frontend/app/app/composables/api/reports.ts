import { getReportsContract } from '@cat-factory/contracts'
import type { ReportWindow } from '~/types/execution'
import type { ApiContext } from './context'

/**
 * Reports: cross-cutting usage analytics for an account over a time window
 * (admin-gated). The sibling of `platformObservabilityApi` — same account scope,
 * a different question ("where did the spend and the work go" vs "is it healthy").
 * `workspaceId` narrows every breakdown to one board.
 */
export function reportsApi({ send }: ApiContext) {
  return {
    getReports: (accountId: string, window: ReportWindow, workspaceId?: string | null) =>
      send(getReportsContract, {
        pathParams: { accountId },
        queryParams: { window, ...(workspaceId ? { workspaceId } : {}) },
      }),
  }
}
