import type { ReportWindow, ReportsView } from '@cat-factory/contracts'
import type { Clock, ReportRange, ReportScope, ReportsRepository } from '@cat-factory/kernel'
import {
  REPORT_WINDOWS,
  buildSpendTrend,
  foldTotals,
  toActivityRow,
  toSpendRow,
} from './reports.logic.js'

export interface ReportsServiceDependencies {
  reportsRepository: ReportsRepository
  clock: Clock
  /**
   * The deployment's spend currency (the base pricing table's), so the SPA formats every
   * cost without a second call. Deliberately the BASE currency and not a workspace's
   * override: an account-wide report spans boards that may each override it, and summing
   * differently-denominated costs into one number would be wrong.
   */
  currency: string
}

/**
 * Cross-cutting usage analytics: composes the rollups behind {@link ReportsRepository}
 * into the Reports view — spend sliced by model and agent kind, spend and run activity
 * sliced by workspace / service / task type, and a spend trend, over a time window.
 *
 * The dual of {@link PlatformObservabilityService}: that answers "is the deployment
 * healthy", this answers "where are the money and the work going". Every breakdown is one
 * SQL GROUP BY, and they are independent aggregates run in parallel — NOT an N+1. The
 * reshaping (totals fold, trend zero-fill) is the pure logic in `reports.logic.ts`.
 */
export class ReportsService {
  constructor(private readonly deps: ReportsServiceDependencies) {}

  async summarize(
    accountId: string,
    window: ReportWindow,
    workspaceId?: string | null,
  ): Promise<ReportsView> {
    const { windowMs, bucketMs } = REPORT_WINDOWS[window]
    const until = this.deps.clock.now()
    const since = until - windowMs
    const scope: ReportScope = { accountId, workspaceId: workspaceId ?? null }
    const range: ReportRange = { since, until }
    const repo = this.deps.reportsRepository
    const [
      byModel,
      byAgentKind,
      spendByWorkspace,
      spendByService,
      spendByTaskType,
      activityByWorkspace,
      activityByService,
      activityByTaskType,
      trend,
    ] = await Promise.all([
      repo.spendByDimension(scope, 'model', range),
      repo.spendByDimension(scope, 'agentKind', range),
      repo.spendByDimension(scope, 'workspace', range),
      repo.spendByDimension(scope, 'service', range),
      repo.spendByDimension(scope, 'taskType', range),
      repo.activityByDimension(scope, 'workspace', range),
      repo.activityByDimension(scope, 'service', range),
      repo.activityByDimension(scope, 'taskType', range),
      repo.spendTrend(scope, range, bucketMs),
    ])
    const spendByModel = byModel.map(toSpendRow)
    return {
      window,
      generatedAt: until,
      since,
      workspaceId: workspaceId ?? null,
      currency: this.deps.currency,
      // Every spend breakdown partitions the same ledger rows, so the totals fold from
      // whichever one is at hand rather than costing a sixth query.
      totals: foldTotals(spendByModel),
      spend: {
        byModel: spendByModel,
        byAgentKind: byAgentKind.map(toSpendRow),
        byWorkspace: spendByWorkspace.map(toSpendRow),
        byService: spendByService.map(toSpendRow),
        byTaskType: spendByTaskType.map(toSpendRow),
      },
      activity: {
        byWorkspace: activityByWorkspace.map(toActivityRow),
        byService: activityByService.map(toActivityRow),
        byTaskType: activityByTaskType.map(toActivityRow),
      },
      trend: { bucketMs, points: buildSpendTrend(trend, since, until, bucketMs) },
    }
  }
}
