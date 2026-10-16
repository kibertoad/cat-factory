import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  ReportActivityRow,
  ReportSpendRow,
  ReportsView,
  ReportWindow,
} from '~/types/execution'
import { getReportsContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import { accountBoards, accounts, orgAccount } from '~/stories/accounts.stories.mocks'
import { spendRow } from '~/stories/reports.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useReportsStore } from '~/stores/reports'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import ReportsPanel from './ReportsPanel.vue'

// The account's reports, a full-screen overlay: where the spend and the runs go. Totals, a spend
// trend, spend by model, agent kind, ticket and run, and a breakdown by board, service,
// repository or task type with the runs beside the spend. A subscription call's cost is
// illustrative and never counted as spend. The short windows read the cost ledger; 30 and 90
// days read a durable daily rollup, and the panel says how far that reaches. It loads the
// account's report when it opens, so each story opens it and answers that read. The keys and
// labels follow the backend's (`D1ReportsRepository.ts`): model, agent kind and task type rows
// carry no label, so they show their raw key. The amounts are made up.
//
// The spend trend draws no bars, for the same reason as the operator dashboard's: its row aligns
// the columns to the end (`items-end`), so the bars' percentage heights resolve to nothing (#2395).

const DAY = 24 * 3_600_000
const NOW = Date.UTC(2026, 9, 11, 12, 0)

const byModel = [
  spendRow('anthropic:claude-sonnet-5-5', null, 121.4),
  spendRow('anthropic:claude-opus-5-5', null, 41.9, 38.2),
  spendRow('anthropic:claude-haiku-5-5', null, 10.9, 14.4),
]

const meta = {
  title: 'Run telemetry/Pages/ReportsPanel',
  component: ReportsPanel,
  decorators: [withReports('7d')],
  parameters: { api: [reportIs(report())] },
} satisfies Meta<typeof ReportsPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The Acme account active with its boards, the window chosen, and the panel open. */
function withReports(window: ReportWindow, workspaceFilter: string | null = null) {
  return withSeed(() => {
    const accountsStore = useAccountsStore()
    accountsStore.accounts = accounts
    accountsStore.activeAccountId = orgAccount.id
    useWorkspaceStore().workspaces = accountBoards
    const reports = useReportsStore()
    reports.window = window
    reports.workspaceFilter = workspaceFilter
    useUiStore().openReports()
  })
}

function reportIs(view: ReportsView) {
  return apiResponse(getReportsContract, { pathParams: { accountId: orgAccount.id }, body: view })
}

/** An activity slice: `done` and `failed` runs, plus `running`, averaging `avgMin` minutes. */
function runs(
  key: string,
  label: string | null,
  done: number,
  failed: number,
  running = 0,
  avgMin: number | null = 21,
): ReportActivityRow {
  return {
    key,
    label,
    runs: done + failed + running,
    done,
    failed,
    running,
    other: 0,
    avgDurationMs: avgMin === null ? null : avgMin * 60_000,
  }
}

/** Daily points, quieter at the weekend. Seven of them add up to the week's totals. */
function dailyTrend(days: number) {
  return Array.from({ length: days }, (_, i) => {
    const weekend = i % 7 === 3 || i % 7 === 4
    const metered = weekend ? 6.4 : 28.08 + (i % 3) * 4.2
    const subscription = weekend ? 1.1 : 10.08
    return {
      start: NOW - (days - i) * DAY,
      meteredCost: metered,
      subscriptionCost: subscription,
      calls: Math.round((metered + subscription) * 9),
      inputTokens: Math.round((metered + subscription) * 9) * 21_000,
      outputTokens: Math.round((metered + subscription) * 9) * 1_400,
    }
  })
}

/** The window's totals, as the sum of one breakdown's rows. */
function totalOf(rows: ReportSpendRow[]): ReportsView['totals'] {
  const sum = (pick: (r: ReportSpendRow) => number) =>
    Math.round(rows.reduce((n, r) => n + pick(r), 0) * 100) / 100
  return {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    calls: sum((r) => r.calls),
    meteredCost: sum((r) => r.meteredCost),
    subscriptionCost: sum((r) => r.subscriptionCost),
  }
}

/** The Acme account's last seven days, read from the cost ledger. */
function report(overrides: Partial<ReportsView> = {}): ReportsView {
  return {
    window: '7d',
    generatedAt: NOW,
    since: NOW - 7 * DAY,
    workspaceId: null,
    currency: 'EUR',
    source: 'ledger',
    rolledUpThrough: null,
    totals: totalOf(byModel),
    spend: {
      byModel,
      byAgentKind: [
        spendRow('coder', null, 88.3, 30.1),
        spendRow('reviewer', null, 34.6, 9.2),
        spendRow('architect', null, 26.7, 8.9),
        spendRow('tester-api', null, 18.1),
        spendRow('kaizen', null, 6.5, 4.4),
      ],
      byWorkspace: [
        spendRow(STORY_WORKSPACE_ID, 'Core services', 112.8, 41.3),
        spendRow('ws_payments', 'Payments platform', 47.9, 11.3),
        spendRow('ws_mobile', 'Mobile app', 11.4),
        spendRow('', null, 2.1),
      ],
      byService: [
        spendRow('svc_auth', 'Auth Service', 81.2, 29.5),
        spendRow('svc_gateway', 'API Gateway', 31.6, 11.8),
        spendRow('svc_ledger', 'Ledger', 47.9, 11.3),
        spendRow('', null, 13.5),
      ],
      byRepo: [
        spendRow('101', 'acme/auth-service', 81.2, 29.5),
        spendRow('102', 'acme/api-gateway', 31.6, 11.8),
        spendRow('734102', 'acme/platform', 47.9, 11.3),
        spendRow('', null, 13.5),
      ],
      byTaskType: [
        spendRow('feature', null, 118.6, 37.4),
        spendRow('bug', null, 41.3, 12.1),
        spendRow('review', null, 14.3, 3.1),
      ],
      byTicket: [
        spendRow('jira:AUTH-142', null, 22.7, 8.4),
        spendRow('github:acme/auth-service#88', null, 9.6),
      ],
      byRun: [
        spendRow('exec_login', 'Login endpoint', 18.3, 7.2),
        spendRow('exec_rate_limit', 'Rate-limit login attempts', 14.9, 3.8),
        spendRow('exec_bootstrap_billing', null, 6.2),
      ],
    },
    capped: [],
    activity: {
      byWorkspace: [
        runs(STORY_WORKSPACE_ID, 'Core services', 31, 4, 2),
        runs('ws_payments', 'Payments platform', 12, 2, 1, 34),
        runs('ws_mobile', 'Mobile app', 5, 0, 0, 12),
      ],
      byService: [
        runs('svc_auth', 'Auth Service', 22, 3, 1),
        runs('svc_gateway', 'API Gateway', 9, 1, 1, 18),
        runs('svc_ledger', 'Ledger', 12, 2, 1, 34),
      ],
      byRepo: [
        runs('101', 'acme/auth-service', 22, 3, 1),
        runs('102', 'acme/api-gateway', 9, 1, 1, 18),
        runs('734102', 'acme/platform', 12, 2, 1, 34),
      ],
      byTaskType: [
        runs('feature', null, 29, 3, 2, 26),
        runs('bug', null, 15, 3, 1, 14),
        runs('review', null, 4, 0, 0, 9),
      ],
    },
    trend: { bucketMs: DAY, points: dailyTrend(7) },
    ...overrides,
  }
}

/**
 * Seven days: the four totals, an empty trend box (see above), spend by model, agent kind, ticket
 * and run, and the boards with their runs. Model, agent kind and task type rows show their raw
 * keys; the bootstrap run has no task, so it shows its run id.
 */
export const Default: Story = {}

/** The first load in flight: placeholder blocks. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(getReportsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}

/** The read failed: a translated heading, the client's message under it, and Retry. */
export const Failed: Story = {
  parameters: {
    api: [apiFailure(getReportsContract, { pathParams: { accountId: orgAccount.id } })],
  },
}

/** A new account: no usage and no runs, so each section says it has nothing for this window. */
export const Empty: Story = {
  parameters: {
    api: [
      reportIs(
        report({
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            calls: 0,
            meteredCost: 0,
            subscriptionCost: 0,
          },
          spend: {
            byModel: [],
            byAgentKind: [],
            byWorkspace: [],
            byService: [],
            byRepo: [],
            byTaskType: [],
            byTicket: [],
            byRun: [],
          },
          activity: { byWorkspace: [], byService: [], byRepo: [], byTaskType: [] },
          trend: { bucketMs: DAY, points: [] },
        }),
      ),
    ],
  },
}

type Amounts = Pick<
  ReportSpendRow,
  'inputTokens' | 'outputTokens' | 'calls' | 'meteredCost' | 'subscriptionCost'
>
const AMOUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'calls',
  'meteredCost',
  'subscriptionCost',
] as const

/** The account's totals for the seven-day report: what every full breakdown adds up to. */
const accountTotals = totalOf(byModel)

/** The sum of some rows' amounts, each field rounded to cents. */
function sumOf(rows: Amounts[]): Amounts {
  return totalOf(rows as ReportSpendRow[])
}

/**
 * The rows scaled down or up to `target`, so they add up to it. Each field is rounded, and the
 * first row takes the rounding rest.
 */
function scaleTo<T extends Amounts>(rows: T[], target: Amounts): T[] {
  const all = sumOf(rows)
  const out = rows.map((r) => ({ ...r }))
  for (const f of AMOUNT_FIELDS) {
    const cents = f === 'meteredCost' || f === 'subscriptionCost' ? 100 : 1
    const share = all[f] === 0 ? 0 : target[f] / all[f]
    for (const r of out) r[f] = Math.round(r[f] * share * cents) / cents
    const rest = target[f] - out.reduce((n, r) => n + r[f], 0)
    out[0]![f] = Math.round((out[0]![f] + rest) * cents) / cents
  }
  return out
}

/** The ticket and run rows cover only part of the spend, so they scale by the share alone. */
function scaleBySpendShare(rows: ReportSpendRow[], target: Amounts): ReportSpendRow[] {
  const share =
    (target.meteredCost + target.subscriptionCost) /
    (accountTotals.meteredCost + accountTotals.subscriptionCost)
  return rows.map((r) =>
    spendRow(
      r.key,
      r.label,
      Math.round(r.meteredCost * share * 100) / 100,
      Math.round(r.subscriptionCost * share * 100) / 100,
    ),
  )
}

/** The seven-day report's spend breakdowns, scaled to a new window's totals. */
function spendScaledTo(target: Amounts): ReportsView['spend'] {
  const base = report().spend
  return {
    byModel: scaleTo(base.byModel, target),
    byAgentKind: scaleTo(base.byAgentKind, target),
    byWorkspace: scaleTo(base.byWorkspace, target),
    byService: scaleTo(base.byService, target),
    byRepo: scaleTo(base.byRepo, target),
    byTaskType: scaleTo(base.byTaskType, target),
    byTicket: scaleBySpendShare(base.byTicket, target),
    byRun: scaleBySpendShare(base.byRun, target),
  }
}

const staleThrough = Date.UTC(2026, 9, 6)

/**
 * Thirty days from the durable cost rollup, which reaches only 6 October: a warning names the
 * date, so the empty days after it read as missing data, not as a cheap week. The totals are the
 * sum of the trend's points, and the breakdowns are scaled to them.
 */
export const RollupStale: Story = {
  decorators: [withReports('30d')],
  parameters: {
    api: [
      (() => {
        const points = dailyTrend(30).map((p) =>
          p.start > staleThrough
            ? {
                ...p,
                meteredCost: 0,
                subscriptionCost: 0,
                calls: 0,
                inputTokens: 0,
                outputTokens: 0,
              }
            : p,
        )
        const totals = sumOf(points)
        return reportIs(
          report({
            window: '30d',
            since: NOW - 30 * DAY,
            source: 'daily-rollup',
            rolledUpThrough: staleThrough,
            totals: totals as ReportsView['totals'],
            spend: spendScaledTo(totals),
            trend: { bucketMs: DAY, points },
          }),
        )
      })(),
    ],
  },
}

const board = spendRow(STORY_WORKSPACE_ID, 'Core services', 112.8, 41.3)

/**
 * Narrowed to Core services: the board filter names it, and every section is that board's. The
 * trend, the model, agent kind, task type, ticket and run rows are the account's rows scaled to
 * the board's share, so each full breakdown and the trend add up to the totals.
 */
export const FilteredToBoard: Story = {
  decorators: [withReports('7d', STORY_WORKSPACE_ID)],
  parameters: {
    api: [
      reportIs(
        report({
          workspaceId: STORY_WORKSPACE_ID,
          totals: totalOf([board]),
          trend: { bucketMs: DAY, points: scaleTo(dailyTrend(7), board) },
          spend: {
            ...report().spend,
            byModel: scaleTo(report().spend.byModel, board),
            byAgentKind: scaleTo(report().spend.byAgentKind, board),
            byWorkspace: [board],
            byService: report().spend.byService.slice(0, 2),
            byRepo: report().spend.byRepo.slice(0, 2),
            byTaskType: scaleTo(report().spend.byTaskType, board),
            byTicket: scaleBySpendShare(report().spend.byTicket, board),
            byRun: scaleBySpendShare(report().spend.byRun, board),
          },
          activity: {
            ...report().activity,
            byWorkspace: [runs(STORY_WORKSPACE_ID, 'Core services', 31, 4, 2)],
            byService: report().activity.byService.slice(0, 2),
            byRepo: report().activity.byRepo.slice(0, 2),
          },
        }),
      ),
    ],
  },
}
